import { type EventInput, EventSchema } from "@pulse/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { events, issueActivity, issues, projects } from "../src/db/schema.js";
import { saveEvent } from "../src/events/store.js";
import { createTestUser, deleteTestUsers } from "./helpers.js";

const PREFIX = "grouptest-";
const run = Date.now();

let orgId: string;

// Each test gets its own project, so issues from one test never mix with another's
async function newProject() {
  const [project] = await db
    .insert(projects)
    .values({ orgId, name: "Grouping", slug: crypto.randomUUID(), platform: "node" })
    .returning();
  return project?.id ?? "";
}

// Calls the worker's save step directly: same code path, no queue timing to wait for
function save(projectId: string, input: EventInput) {
  return saveEvent({
    projectId,
    receivedAt: new Date().toISOString(),
    event: EventSchema.parse(input),
  });
}

const issuesOf = (projectId: string) =>
  db.select().from(issues).where(eq(issues.projectId, projectId));

const checkoutCrash = (lineno = 42): EventInput => ({
  exception: {
    type: "TypeError",
    value: "Cannot read properties of undefined (reading 'total')",
    stacktrace: { frames: [{ filename: "src/cart.js", function: "checkout", lineno }] },
  },
});

beforeAll(async () => {
  const owner = await createTestUser(`${PREFIX}owner-${run}@example.com`, "Owner");
  orgId = owner.org.id;
});

afterAll(async () => {
  await deleteTestUsers(PREFIX); // org → projects → issues, events, issue_users cascade
});

describe("grouping events into issues", () => {
  it("turns 1000 identical errors into exactly one issue", async () => {
    const projectId = await newProject();

    // 20 at a time, so several transactions really race for the same new issue
    for (let batch = 0; batch < 50; batch++) {
      await Promise.all(Array.from({ length: 20 }, () => save(projectId, checkoutCrash())));
    }

    const found = await issuesOf(projectId);
    expect(found).toHaveLength(1);
    expect(found[0]?.eventCount).toBe(1000);

    const linked = await db.select().from(events).where(eq(events.projectId, projectId));
    expect(linked).toHaveLength(1000);
    expect(linked.every((e) => e.issueId === found[0]?.id)).toBe(true);
  }, 30_000);

  it("groups by stack, not line numbers, and splits different types", async () => {
    const projectId = await newProject();
    await save(projectId, checkoutCrash(42));
    await save(projectId, checkoutCrash(57));
    await save(projectId, { exception: { type: "RangeError", value: "Invalid array length" } });

    const found = await issuesOf(projectId);
    expect(found).toHaveLength(2);
    expect(found.find((i) => i.type === "TypeError")?.eventCount).toBe(2);
  });

  it("fills in title, culprit, severity and first/last seen", async () => {
    const projectId = await newProject();
    await save(projectId, {
      ...checkoutCrash(),
      level: "fatal",
      timestamp: "2026-10-22T10:00:00Z",
    });
    // An older event arriving late moves first_seen back, not last_seen
    await save(projectId, { ...checkoutCrash(), timestamp: "2026-10-21T08:00:00Z" });

    const [issue] = await issuesOf(projectId);
    expect(issue?.title).toBe("TypeError: Cannot read properties of undefined (reading 'total')");
    expect(issue?.culprit).toBe("checkout (src/cart.js)");
    expect(issue?.severity).toBe("critical"); // from the first event's level
    expect(issue?.status).toBe("unresolved");
    expect(issue?.firstSeen.toISOString()).toBe("2026-10-21T08:00:00.000Z");
    expect(issue?.lastSeen.toISOString()).toBe("2026-10-22T10:00:00.000Z");
  });

  it("does not count a retried event twice", async () => {
    const projectId = await newProject();
    const retried = { ...checkoutCrash(), event_id: "a".repeat(32) };
    expect(await save(projectId, retried)).not.toBeNull();
    expect(await save(projectId, retried)).toBeNull();

    const [issue] = await issuesOf(projectId);
    expect(issue?.eventCount).toBe(1);
  });
});

describe("counting affected users", () => {
  it("counts each user once, by id, then email, then ip", async () => {
    const projectId = await newProject();
    const as = (user?: EventInput["user"]) => save(projectId, { ...checkoutCrash(), user });

    await as({ id: "1" });
    await as({ id: "1", email: "one@example.com" }); // same user (id wins)
    await as({ email: "two@example.com" });
    await as({ email: "TWO@example.com" }); // same email, different case
    await as({ ip: "10.0.0.3" });
    await as(undefined); // anonymous: counts as an event, not a user

    const [issue] = await issuesOf(projectId);
    expect(issue?.eventCount).toBe(6);
    expect(issue?.userCount).toBe(3);
  });
});

describe("regressions", () => {
  it("reopens a resolved issue when the error comes back", async () => {
    const projectId = await newProject();
    await save(projectId, checkoutCrash());
    const [issue] = await issuesOf(projectId);
    if (!issue) throw new Error("issue should exist");

    // Resolving is an API action in F6; here we set it directly
    await db
      .update(issues)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(issues.id, issue.id));

    await save(projectId, checkoutCrash());

    const [reopened] = await issuesOf(projectId);
    expect(reopened?.status).toBe("unresolved");
    expect(reopened?.isRegression).toBe(true);
    expect(reopened?.resolvedAt).toBeNull();
    expect(reopened?.eventCount).toBe(2);

    const activity = await db
      .select()
      .from(issueActivity)
      .where(eq(issueActivity.issueId, issue.id));
    expect(activity.map((a) => a.action)).toEqual(["regression"]);
  });

  it("leaves ignored issues ignored", async () => {
    const projectId = await newProject();
    await save(projectId, checkoutCrash());
    await db.update(issues).set({ status: "ignored" }).where(eq(issues.projectId, projectId));

    await save(projectId, checkoutCrash());

    const [issue] = await issuesOf(projectId);
    expect(issue?.status).toBe("ignored");
    expect(issue?.eventCount).toBe(2);
  });
});
