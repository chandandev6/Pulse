import { type EventInput, EventSchema } from "@pulse/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/client.js";
import { issues, projects } from "../src/db/schema.js";
import { saveEvent } from "../src/events/store.js";
import { addMember, createTestUser, deleteTestUsers } from "./helpers.js";

const app = buildApp();

const PREFIX = "issuetest-";
const run = Date.now();
const email = (name: string) => `${PREFIX}${name}-${run}@example.com`;

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
let owner: TestUser;
let member: TestUser;
let outsider: TestUser;

function as(user: TestUser, method: "GET" | "PATCH", url: string, body?: object) {
  return app.inject({ method, url, cookies: user.cookies, payload: body });
}

async function newProject() {
  const [project] = await db
    .insert(projects)
    .values({ orgId: owner.org.id, name: "Issues", slug: crypto.randomUUID(), platform: "node" })
    .returning();
  if (!project) throw new Error("project not created");
  return project.id;
}

// Saves an event the way the worker does and returns its issue id
async function send(projectId: string, input: EventInput) {
  const saved = await saveEvent({
    projectId,
    receivedAt: new Date().toISOString(),
    event: EventSchema.parse(input),
  });
  if (!saved) throw new Error("event not saved");
  return saved;
}

const crash = (type: string, extra: Partial<EventInput> = {}): EventInput => ({
  exception: { type, value: `${type} happened` },
  ...extra,
});

beforeAll(async () => {
  await app.ready();
  owner = await createTestUser(email("owner"), "Owner");
  member = await createTestUser(email("member"), "Member");
  outsider = await createTestUser(email("outsider"), "Outsider");
  await addMember(owner.org.id, member.user.id);
});

afterAll(async () => {
  await deleteTestUsers(PREFIX);
  await app.close();
});

describe("GET /projects/:projectId/issues", () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = await newProject();
    // A: 3 events, newest. B: 1 event, oldest. C: 2 events, then resolved.
    for (let i = 0; i < 3; i++)
      await send(projectId, crash("AError", { timestamp: "2026-10-03T00:00:00Z" }));
    await send(projectId, crash("BError", { timestamp: "2026-10-01T00:00:00Z" }));
    const c = await send(projectId, crash("CError", { timestamp: "2026-10-02T00:00:00Z" }));
    await send(projectId, crash("CError", { timestamp: "2026-10-02T00:00:00Z" }));
    await db.update(issues).set({ status: "resolved" }).where(eq(issues.id, c.issueId));
  });

  const typesOf = (body: { issues: { type: string }[] }) => body.issues.map((i) => i.type);

  it("lists the project's issues, most recently seen first", async () => {
    const res = await as(member, "GET", `/projects/${projectId}/issues`);

    expect(res.statusCode).toBe(200);
    expect(typesOf(res.json())).toEqual(["AError", "CError", "BError"]);
    expect(res.json().nextCursor).toBeNull();
  });

  it("sorts by event count and filters by status", async () => {
    const byCount = await as(member, "GET", `/projects/${projectId}/issues?sort=event_count`);
    expect(typesOf(byCount.json())).toEqual(["AError", "CError", "BError"]);

    const open = await as(member, "GET", `/projects/${projectId}/issues?status=unresolved`);
    expect(typesOf(open.json())).toEqual(["AError", "BError"]);
  });

  it("pages through every issue exactly once", async () => {
    for (const sort of ["last_seen", "first_seen", "event_count", "user_count"]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor ? `&cursor=${cursor}` : "";
        const res = await as(
          member,
          "GET",
          `/projects/${projectId}/issues?sort=${sort}&limit=1${query}`,
        );
        expect(res.statusCode).toBe(200);
        seen.push(...typesOf(res.json()));
        cursor = res.json().nextCursor;
      } while (cursor);

      expect(seen.sort()).toEqual(["AError", "BError", "CError"]);
    }
  });

  it("rejects bad cursors and bad sorts with 400", async () => {
    const bad = await as(member, "GET", `/projects/${projectId}/issues?cursor=garbage`);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("INVALID_CURSOR");

    // A cursor made for one sort can't be used with another
    const first = await as(member, "GET", `/projects/${projectId}/issues?limit=1`);
    const mixed = await as(
      member,
      "GET",
      `/projects/${projectId}/issues?sort=event_count&cursor=${first.json().nextCursor}`,
    );
    expect(mixed.statusCode).toBe(400);

    expect((await as(member, "GET", `/projects/${projectId}/issues?sort=title`)).statusCode).toBe(
      400,
    );
  });

  it("is hidden from other orgs", async () => {
    const res = await as(outsider, "GET", `/projects/${projectId}/issues`);
    expect(res.statusCode).toBe(404);
  });
});

describe("issue details and events", () => {
  let projectId: string;
  let issueId: string;
  let latestEventId: string;

  beforeAll(async () => {
    projectId = await newProject();
    const at = (day: number, environment: string, release: string) =>
      send(
        projectId,
        crash("TypeError", { timestamp: `2026-10-0${day}T00:00:00Z`, environment, release }),
      );

    await at(1, "production", "1.0.0");
    await at(2, "production", "1.1.0");
    await at(3, "staging", "1.1.0");
    ({ id: latestEventId, issueId } = await at(4, "production", "1.1.0"));
  });

  it("returns the issue with its latest event and where it happens", async () => {
    const res = await as(member, "GET", `/issues/${issueId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.issue).toMatchObject({
      id: issueId,
      title: "TypeError: TypeError happened",
      status: "unresolved",
      eventCount: 4,
      assignee: null,
    });
    expect(body.latestEvent.id).toBe(latestEventId);
    expect(body.environments).toEqual([
      { name: "production", count: 3 },
      { name: "staging", count: 1 },
    ]);
    expect(body.releases).toEqual([
      {
        name: "1.1.0",
        count: 3,
        firstSeen: "2026-10-02T00:00:00.000Z",
        lastSeen: "2026-10-04T00:00:00.000Z",
      },
      {
        name: "1.0.0",
        count: 1,
        firstSeen: "2026-10-01T00:00:00.000Z",
        lastSeen: "2026-10-01T00:00:00.000Z",
      },
    ]);
  });

  it("pages through the issue's events, newest first", async () => {
    const page1 = await as(member, "GET", `/issues/${issueId}/events?limit=3`);
    expect(page1.json().events.map((e: { release: string }) => e.release)).toEqual([
      "1.1.0",
      "1.1.0",
      "1.1.0",
    ]);

    const page2 = await as(
      member,
      "GET",
      `/issues/${issueId}/events?limit=3&cursor=${page1.json().nextCursor}`,
    );
    expect(page2.json().events.map((e: { release: string }) => e.release)).toEqual(["1.0.0"]);
    expect(page2.json().nextCursor).toBeNull();
  });

  it("returns one full event", async () => {
    const res = await as(member, "GET", `/events/${latestEventId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().event).toMatchObject({ id: latestEventId, issueId, type: "TypeError" });
  });

  it("hides issues and events from other orgs", async () => {
    for (const url of [
      `/issues/${issueId}`,
      `/issues/${issueId}/events`,
      `/issues/${issueId}/activity`,
      `/events/${latestEventId}`,
      "/issues/not-a-uuid",
    ]) {
      expect((await as(outsider, "GET", url)).statusCode).toBe(404);
    }
    expect(
      (await as(outsider, "PATCH", `/issues/${issueId}`, { status: "resolved" })).statusCode,
    ).toBe(404);
  });
});

describe("PATCH /issues/:issueId", () => {
  it("lets a member resolve, and logs who did it", async () => {
    const projectId = await newProject();
    const { issueId } = await send(projectId, crash("TypeError"));

    const res = await as(member, "PATCH", `/issues/${issueId}`, { status: "resolved" });
    expect(res.statusCode).toBe(200);
    expect(res.json().issue.status).toBe("resolved");
    expect(res.json().issue.resolvedAt).not.toBeNull();

    const activity = (await as(member, "GET", `/issues/${issueId}/activity`)).json().activity;
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      action: "status_changed",
      data: { from: "unresolved", to: "resolved" },
      actor: { id: member.user.id, name: "Member" },
    });
  });

  it("reopens as a regression when the error comes back after resolving", async () => {
    const projectId = await newProject();
    const { issueId } = await send(projectId, crash("TypeError"));
    await as(member, "PATCH", `/issues/${issueId}`, { status: "resolved" });

    await send(projectId, crash("TypeError"));

    const { issue } = (await as(member, "GET", `/issues/${issueId}`)).json();
    expect(issue).toMatchObject({ status: "unresolved", isRegression: true, resolvedAt: null });

    const activity = (await as(member, "GET", `/issues/${issueId}/activity`)).json().activity;
    expect(activity.map((a: { action: string }) => a.action)).toEqual([
      "regression",
      "status_changed",
    ]);
    expect(activity[0].actor).toBeNull(); // Pulse did it, not a person

    // Resolving again clears the regression flag
    const resolved = await as(member, "PATCH", `/issues/${issueId}`, { status: "resolved" });
    expect(resolved.json().issue.isRegression).toBe(false);
  });

  it("keeps a manually set severity when new events arrive", async () => {
    const projectId = await newProject();
    const { issueId } = await send(projectId, crash("TypeError", { level: "error" }));

    const res = await as(member, "PATCH", `/issues/${issueId}`, { severity: "low" });
    expect(res.json().issue.severity).toBe("low");

    await send(projectId, crash("TypeError", { level: "fatal" }));
    const { issue } = (await as(member, "GET", `/issues/${issueId}`)).json();
    expect(issue.severity).toBe("low");
  });

  it("assigns only to members of the org", async () => {
    const projectId = await newProject();
    const { issueId } = await send(projectId, crash("TypeError"));
    const url = `/issues/${issueId}`;

    const outside = await as(owner, "PATCH", url, { assigneeId: outsider.user.id });
    expect(outside.statusCode).toBe(400);
    expect(outside.json().error.code).toBe("INVALID_ASSIGNEE");

    await as(owner, "PATCH", url, { assigneeId: member.user.id });
    const { issue } = (await as(member, "GET", url)).json();
    expect(issue.assignee).toEqual({
      id: member.user.id,
      name: "Member",
      email: member.user.email,
    });

    await as(owner, "PATCH", url, { assigneeId: null });
    const actions = (await as(member, "GET", `${url}/activity`))
      .json()
      .activity.map((a: { action: string }) => a.action);
    expect(actions).toEqual(["unassigned", "assigned"]);
  });

  it("logs nothing when nothing changes, and validates input", async () => {
    const projectId = await newProject();
    const { issueId } = await send(projectId, crash("TypeError"));
    const url = `/issues/${issueId}`;

    expect((await as(member, "PATCH", url, { status: "unresolved" })).statusCode).toBe(200);
    expect((await as(member, "GET", `${url}/activity`)).json().activity).toEqual([]);

    expect((await as(member, "PATCH", url, {})).statusCode).toBe(400);
    expect((await as(member, "PATCH", url, { status: "fixed" })).statusCode).toBe(400);
    expect((await as(member, "PATCH", url, { severity: "urgent" })).statusCode).toBe(400);
  });
});

describe("PATCH /projects/:projectId/issues (bulk)", () => {
  it("updates many issues, but only in that project", async () => {
    const projectId = await newProject();
    const otherProjectId = await newProject();
    const a = await send(projectId, crash("AError"));
    const b = await send(projectId, crash("BError"));
    const elsewhere = await send(otherProjectId, crash("CError"));

    const res = await as(member, "PATCH", `/projects/${projectId}/issues`, {
      ids: [a.issueId, b.issueId, elsewhere.issueId],
      status: "ignored",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().issues.map((i: { status: string }) => i.status)).toEqual([
      "ignored",
      "ignored",
    ]);

    const [untouched] = await db.select().from(issues).where(eq(issues.id, elsewhere.issueId));
    expect(untouched?.status).toBe("unresolved");
  });

  it("needs ids and at least one change", async () => {
    const projectId = await newProject();
    const url = `/projects/${projectId}/issues`;
    expect((await as(member, "PATCH", url, { status: "resolved" })).statusCode).toBe(400);
    expect((await as(member, "PATCH", url, { ids: [crypto.randomUUID()] })).statusCode).toBe(400);
  });
});

describe("dashboard helpers", () => {
  it("returns overview stats for the last 24 hours", async () => {
    const projectId = await newProject();
    const now = new Date().toISOString();
    await send(projectId, crash("AError", { level: "fatal", timestamp: now, user: { id: "1" } }));
    await send(projectId, crash("AError", { timestamp: now, user: { id: "1" } }));
    await send(projectId, crash("BError", { timestamp: now, user: { email: "b@example.com" } }));
    await send(
      projectId,
      crash("CError", { timestamp: "2020-01-01T00:00:00Z", user: { id: "9" } }),
    );

    const res = await as(member, "GET", `/projects/${projectId}/stats`);
    expect(res.statusCode).toBe(200);
    expect(res.json().stats).toEqual({
      activeIssues: 3,
      criticalIssues: 1, // AError started as fatal
      events24h: 3, // the 2020 event is too old
      users24h: 2,
      totalUsers: 3, // all time: the 2020 user counts here
    });
  });

  it("links each event to the older and newer one in its issue", async () => {
    const projectId = await newProject();
    const at = (day: number) =>
      send(projectId, crash("TypeError", { timestamp: `2026-10-0${day}T00:00:00Z` }));
    const first = await at(1);
    const middle = await at(2);
    const last = await at(3);

    const res = await as(member, "GET", `/events/${middle.id}`);
    expect(res.json()).toMatchObject({ previousEventId: first.id, nextEventId: last.id });

    const oldest = await as(member, "GET", `/events/${first.id}`);
    expect(oldest.json()).toMatchObject({ previousEventId: null, nextEventId: middle.id });
  });
});
