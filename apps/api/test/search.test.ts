import { type EventInput, EventSchema } from "@pulse/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/client.js";
import { projects } from "../src/db/schema.js";
import { saveEvent } from "../src/events/store.js";
import { createTestUser, deleteTestUsers } from "./helpers.js";

const app = buildApp();

const PREFIX = "searchtest-";
const run = Date.now();
const email = (name: string) => `${PREFIX}${name}-${run}@example.com`;

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
let owner: TestUser;
let outsider: TestUser;

const get = (user: TestUser, url: string) =>
  app.inject({ method: "GET", url, cookies: user.cookies });

async function newProject(orgId = owner.org.id) {
  const [project] = await db
    .insert(projects)
    .values({ orgId, name: "Search", slug: crypto.randomUUID(), platform: "node" })
    .returning();
  if (!project) throw new Error("project not created");
  return project.id;
}

async function send(projectId: string, input: EventInput) {
  const saved = await saveEvent({
    projectId,
    receivedAt: new Date().toISOString(),
    event: EventSchema.parse(input),
  });
  if (!saved) throw new Error("event not saved");
  return saved;
}

const crash = (type: string, value: string, extra: Partial<EventInput> = {}): EventInput => ({
  exception: { type, value },
  ...extra,
});

const typesOf = (res: { json: () => { issues: { type: string }[] } }) =>
  res
    .json()
    .issues.map((issue) => issue.type)
    .sort();

beforeAll(async () => {
  await app.ready();
  owner = await createTestUser(email("owner"), "Owner");
  outsider = await createTestUser(email("outsider"), "Outsider");
});

afterAll(async () => {
  await deleteTestUsers(PREFIX);
  await app.close();
});

describe("searching and filtering issues", () => {
  let projectId: string;
  const list = (query: string) => get(owner, `/projects/${projectId}/issues?${query}`);

  beforeAll(async () => {
    projectId = await newProject();
    // TypeError: production, release 1.0, October 1–3, "high" (from level error)
    await send(
      projectId,
      crash("TypeError", "Cannot read properties of undefined (reading 'total')", {
        environment: "production",
        release: "1.0.0",
        timestamp: "2026-10-01T10:00:00Z",
      }),
    );
    await send(
      projectId,
      crash("TypeError", "Cannot read properties of undefined (reading 'total')", {
        environment: "production",
        release: "1.0.0",
        timestamp: "2026-10-03T10:00:00Z",
      }),
    );
    // RangeError: staging, release 1.1, October 5, "critical" (from level fatal)
    await send(
      projectId,
      crash("RangeError", "Invalid array length", {
        level: "fatal",
        environment: "staging",
        release: "1.1.0",
        timestamp: "2026-10-05T10:00:00Z",
      }),
    );
    // GatewayError: both environments, no release, October 10, "medium" (from level warning)
    for (const environment of ["production", "staging"]) {
      await send(
        projectId,
        crash("GatewayError", "Payment gateway timeout after 100% retries", {
          level: "warning",
          environment,
          timestamp: "2026-10-10T10:00:00Z",
        }),
      );
    }
  });

  it("finds whole words, including other forms of the same word", async () => {
    expect(typesOf(await list("q=properties"))).toEqual(["TypeError"]);
    expect(typesOf(await list("q=read"))).toEqual(["TypeError"]); // "reading" in the title
    expect(typesOf(await list("q=gateway%20timeout"))).toEqual(["GatewayError"]);
  });

  it("finds parts of words with the trigram fallback", async () => {
    expect(typesOf(await list("q=undefin"))).toEqual(["TypeError"]);
    expect(typesOf(await list("q=ngeErr"))).toEqual(["RangeError"]);
  });

  it("treats % and _ as plain text, and odd input as text, not an error", async () => {
    expect(typesOf(await list("q=100%25"))).toEqual(["GatewayError"]);
    expect(typesOf(await list("q=a_b"))).toEqual([]);
    const odd = await list(`q=${encodeURIComponent("'(&|!:*")}`);
    expect(odd.statusCode).toBe(200);
    expect(typesOf(odd)).toEqual([]);
  });

  it("supports exclusions in the search text", async () => {
    expect(typesOf(await list("q=cannot%20-total"))).toEqual([]);
    expect(typesOf(await list("q=invalid%20-gateway"))).toEqual(["RangeError"]);
  });

  it("filters by severity, with a comma list for several", async () => {
    expect(typesOf(await list("severity=critical"))).toEqual(["RangeError"]);
    expect(typesOf(await list("severity=high,critical"))).toEqual(["RangeError", "TypeError"]);
  });

  it("filters by status", async () => {
    expect(typesOf(await list("status=unresolved,ignored"))).toHaveLength(3);
    expect(typesOf(await list("status=resolved"))).toEqual([]);
  });

  it("filters by environment and release (any event matching counts)", async () => {
    expect(typesOf(await list("environment=staging"))).toEqual(["GatewayError", "RangeError"]);
    expect(typesOf(await list("environment=production"))).toEqual(["GatewayError", "TypeError"]);
    expect(typesOf(await list("release=1.0.0,1.1.0"))).toEqual(["RangeError", "TypeError"]);
    expect(typesOf(await list("environment=nowhere"))).toEqual([]);
  });

  it("filters by date range: issues active during it", async () => {
    // TypeError spans Oct 1–3, so a range of Oct 2 only still includes it
    expect(typesOf(await list("since=2026-10-02&until=2026-10-02T23:59:59Z"))).toEqual([
      "TypeError",
    ]);
    expect(typesOf(await list("since=2026-10-04"))).toEqual(["GatewayError", "RangeError"]);
    expect(typesOf(await list("until=2026-10-04"))).toEqual(["TypeError"]);
  });

  it("combines filters (all must match)", async () => {
    expect(typesOf(await list("environment=staging&severity=critical"))).toEqual(["RangeError"]);
    expect(typesOf(await list("environment=staging&q=gateway&since=2026-10-06"))).toEqual([
      "GatewayError",
    ]);
    expect(typesOf(await list("environment=staging&severity=high"))).toEqual([]);
  });

  it("keeps filters while paging", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const after: string = cursor ? `&cursor=${cursor}` : "";
      const res = await list(`environment=production&limit=1${after}`);
      seen.push(...typesOf(res));
      cursor = res.json().nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(["GatewayError", "TypeError"]);
  });

  it("rejects bad filter values with 400", async () => {
    for (const query of [
      "severity=urgent",
      "status=open",
      "since=yesterday",
      "since=2026-10-05&until=2026-10-01",
      `q=${"x".repeat(201)}`,
    ]) {
      const res = await list(query);
      expect(res.statusCode, query).toBe(400);
    }
  });
});

describe("GET /orgs/:orgId/issues", () => {
  let web: string;
  let api: string;

  beforeAll(async () => {
    web = await newProject();
    api = await newProject();
    await send(web, crash("WebError", "Button broke"));
    await send(api, crash("ApiError", "Route broke"));
  });

  it("lists issues from every project in the org", async () => {
    const res = await get(owner, `/orgs/${owner.org.id}/issues?q=broke`);
    expect(res.statusCode).toBe(200);
    expect(typesOf(res)).toEqual(["ApiError", "WebError"]);
  });

  it("filters by project, ignoring projects from other orgs", async () => {
    const otherOrgProject = await newProject(outsider.org.id);
    await send(otherOrgProject, crash("SecretError", "Other org broke"));

    const one = await get(owner, `/orgs/${owner.org.id}/issues?project=${api}`);
    expect(typesOf(one)).toEqual(["ApiError"]);

    const sneaky = await get(owner, `/orgs/${owner.org.id}/issues?project=${otherOrgProject}`);
    expect(sneaky.statusCode).toBe(200);
    expect(typesOf(sneaky)).toEqual([]);
  });

  it("is 404 for people outside the org", async () => {
    const res = await get(outsider, `/orgs/${owner.org.id}/issues`);
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /issues/:issueId/events filters", () => {
  // SDK event ids are 32 hex characters
  const [ADA, BOB, ANON] = ["a", "b", "c"].map((char) => char.repeat(32));
  let issueId: string;
  const events = async (query: string) => {
    const res = await get(owner, `/issues/${issueId}/events?${query}`);
    expect(res.statusCode, query).toBe(200);
    return res.json().events.map((event: { eventId: string }) => event.eventId);
  };

  beforeAll(async () => {
    const projectId = await newProject();
    const base = crash("CheckoutError", "Checkout failed");
    const saved = await send(projectId, {
      ...base,
      event_id: ADA,
      user: { id: "42", email: "ada@example.com" },
      environment: "production",
      release: "2.0.0",
      tags: { browser: "Chrome", region: "eu" },
    });
    issueId = saved.issueId;
    await send(projectId, {
      ...base,
      event_id: BOB,
      user: { username: "bob", ip: "10.0.0.1" },
      environment: "staging",
      release: "2.1.0",
      tags: { browser: "Firefox", region: "eu" },
    });
    await send(projectId, { ...base, event_id: ANON, tags: { browser: "Chrome" } });
  });

  it("finds a user's events by id, email, username or ip", async () => {
    expect(await events("user=42")).toEqual([ADA]);
    expect(await events("user=ada@example.com")).toEqual([ADA]);
    expect(await events("user=bob")).toEqual([BOB]);
    expect(await events("user=10.0.0.1")).toEqual([BOB]);
    expect(await events("user=nobody")).toEqual([]);
  });

  it("filters by environment and release", async () => {
    expect(await events("environment=staging")).toEqual([BOB]);
    expect(await events("release=2.0.0")).toEqual([ADA]);
  });

  it("filters by tags; several tags must all match", async () => {
    expect((await events("tag=browser:Chrome")).sort()).toEqual([ADA, ANON]);
    expect(await events("tag=browser:Chrome&tag=region:eu")).toEqual([ADA]);
    expect(await events("tag=region:asia")).toEqual([]);
  });

  it("rejects a tag without a value with 400", async () => {
    const res = await get(owner, `/issues/${issueId}/events?tag=browser`);
    expect(res.statusCode).toBe(400);
  });
});

describe("time-series", () => {
  const HOUR = 3_600_000;
  let projectId: string;
  let issueId: string;
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

  type Series = { interval: string; buckets: { start: string; count: number }[] };
  const total = (series: Series) => series.buckets.reduce((sum, b) => sum + b.count, 0);

  beforeAll(async () => {
    projectId = await newProject();
    const one = await send(projectId, crash("SlowError", "Slow", { timestamp: hoursAgo(1) }));
    issueId = one.issueId;
    await send(projectId, crash("SlowError", "Slow", { timestamp: hoursAgo(1) }));
    await send(
      projectId,
      crash("OtherError", "Other", { timestamp: hoursAgo(3), environment: "staging" }),
    );
    await send(projectId, crash("OldError", "Old", { timestamp: hoursAgo(24 * 20) }));
  });

  it("counts a project's events per hour for the last 24h, with empty hours as 0", async () => {
    const res = await get(owner, `/projects/${projectId}/timeseries`);
    expect(res.statusCode).toBe(200);
    const series: Series = res.json();

    expect(series.interval).toBe("hour");
    expect(series.buckets).toHaveLength(25); // 24 full hours plus the current one
    expect(series.buckets.at(-2)?.count).toBe(2); // 1 hour ago
    expect(series.buckets.at(-4)?.count).toBe(1); // 3 hours ago
    expect(total(series)).toBe(3); // the 20-day-old event is outside the range
    // Buckets are whole UTC hours, oldest first
    expect(series.buckets[0]?.start).toMatch(/T\d\d:00:00\.000Z$/);
  });

  it("uses days for longer periods", async () => {
    const series: Series = (
      await get(owner, `/projects/${projectId}/timeseries?period=30d`)
    ).json();
    expect(series.interval).toBe("day");
    expect(series.buckets).toHaveLength(31);
    expect(series.buckets[0]?.start).toMatch(/T00:00:00\.000Z$/);
    expect(total(series)).toBe(4);
  });

  it("filters by environment", async () => {
    const res = await get(owner, `/projects/${projectId}/timeseries?environment=staging`);
    expect(total(res.json())).toBe(1);
  });

  it("counts only one issue's events on the issue time-series", async () => {
    const res = await get(owner, `/issues/${issueId}/timeseries?period=7d`);
    expect(res.statusCode).toBe(200);
    expect(res.json().buckets).toHaveLength(7 * 24 + 1);
    expect(total(res.json())).toBe(2);
  });

  it("rejects charts with too many points, and is 404 for outsiders", async () => {
    const tooMany = await get(owner, `/projects/${projectId}/timeseries?period=90d&interval=hour`);
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error.code).toBe("TOO_MANY_BUCKETS");

    const hidden = await get(outsider, `/issues/${issueId}/timeseries`);
    expect(hidden.statusCode).toBe(404);
  });
});
