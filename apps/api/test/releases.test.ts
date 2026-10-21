import { type EventInput, EventSchema } from "@pulse/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/client.js";
import { environments, issues, projects, releases } from "../src/db/schema.js";
import { saveEvent } from "../src/events/store.js";
import { createTestUser, deleteTestUsers } from "./helpers.js";

const app = buildApp();

const PREFIX = "releasetest-";
const run = Date.now();

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
let owner: TestUser;
let outsider: TestUser;

const get = (user: TestUser, url: string) =>
  app.inject({ method: "GET", url, cookies: user.cookies });

async function newProject() {
  const [project] = await db
    .insert(projects)
    .values({ orgId: owner.org.id, name: "Releases", slug: crypto.randomUUID(), platform: "node" })
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

// Different exception types → different issues
const error = (type: string, release: string | undefined, extra: Partial<EventInput> = {}) => ({
  exception: { type, value: `${type} happened` },
  release,
  ...extra,
});

beforeAll(async () => {
  await app.ready();
  owner = await createTestUser(`${PREFIX}owner-${run}@example.com`, "Owner");
  outsider = await createTestUser(`${PREFIX}outsider-${run}@example.com`, "Outsider");
});

afterAll(async () => {
  await deleteTestUsers(PREFIX);
  await app.close();
});

describe("releases and environments are created from events", () => {
  it("counts each release and environment, with first/last seen", async () => {
    const projectId = await newProject();
    await send(projectId, error("AError", "1.0.0", { timestamp: "2026-10-02T00:00:00Z" }));
    await send(projectId, error("BError", "1.0.0", { timestamp: "2026-10-01T00:00:00Z" }));
    await send(
      projectId,
      error("AError", "1.1.0", { timestamp: "2026-10-03T00:00:00Z", environment: "staging" }),
    );
    await send(projectId, error("AError", undefined)); // no release: no release row

    const rows = await db.select().from(releases).where(eq(releases.projectId, projectId));
    const v1 = rows.find((r) => r.version === "1.0.0");
    expect(rows).toHaveLength(2);
    expect(v1).toMatchObject({ eventCount: 2 });
    expect(v1?.firstSeen.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(v1?.lastSeen.toISOString()).toBe("2026-10-02T00:00:00.000Z");

    const envs = await db.select().from(environments).where(eq(environments.projectId, projectId));
    expect(Object.fromEntries(envs.map((e) => [e.name, e.eventCount]))).toEqual({
      production: 3,
      staging: 1,
    });

    const res = await get(owner, `/projects/${projectId}/environments`);
    expect(res.json().environments.map((e: { name: string }) => e.name)).toEqual([
      "production",
      "staging",
    ]);
  });

  it("records which release introduced an issue and the latest one it was seen in", async () => {
    const projectId = await newProject();
    await send(projectId, error("AError", "1.1.0", { timestamp: "2026-10-02T00:00:00Z" }));
    await send(projectId, error("AError", "1.2.0", { timestamp: "2026-10-03T00:00:00Z" }));
    // A late, older event from 1.0.0: the issue really started there
    await send(projectId, error("AError", "1.0.0", { timestamp: "2026-10-01T00:00:00Z" }));
    // An event without a release changes nothing
    await send(projectId, error("AError", undefined, { timestamp: "2026-10-04T00:00:00Z" }));

    const [issue] = await db.select().from(issues).where(eq(issues.projectId, projectId));
    expect(issue).toMatchObject({ firstRelease: "1.0.0", lastRelease: "1.2.0" });
  });
});

describe("GET /projects/:projectId/releases", () => {
  it("lists releases, newest first, with how many issues each introduced", async () => {
    const projectId = await newProject();
    await send(projectId, error("AError", "1.0.0", { timestamp: "2026-10-01T00:00:00Z" }));
    await send(projectId, error("AError", "1.1.0", { timestamp: "2026-10-02T00:00:00Z" }));
    await send(projectId, error("BError", "1.1.0", { timestamp: "2026-10-02T00:00:00Z" }));
    await send(projectId, error("CError", "1.1.0", { timestamp: "2026-10-02T00:00:00Z" }));

    const res = await get(owner, `/projects/${projectId}/releases`);
    expect(res.statusCode).toBe(200);
    expect(
      res
        .json()
        .releases.map((r: { version: string; newIssues: number; eventCount: number }) => [
          r.version,
          r.newIssues,
          r.eventCount,
        ]),
    ).toEqual([
      ["1.1.0", 2, 3], // BError and CError started here
      ["1.0.0", 1, 1], // AError started here
    ]);
  });

  it("is hidden from other orgs", async () => {
    const projectId = await newProject();
    for (const url of ["releases", "environments", "releases/1.0.0", "releases/compare?a=1&b=2"]) {
      expect((await get(outsider, `/projects/${projectId}/${url}`)).statusCode).toBe(404);
    }
  });
});

describe("GET /projects/:projectId/releases/:version", () => {
  it("shows new issues, all issues seen, and affected users", async () => {
    const projectId = await newProject();
    await send(projectId, error("OldError", "1.0.0", { timestamp: "2026-10-01T00:00:00Z" }));
    await send(projectId, error("OldError", "1.1.0", { user: { id: "1" } }));
    await send(projectId, error("NewError", "1.1.0", { user: { id: "2" } }));
    await send(
      projectId,
      error("NewError", "1.1.0", { user: { id: "2" }, environment: "staging" }),
    );

    const res = await get(owner, `/projects/${projectId}/releases/1.1.0`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.release).toMatchObject({ version: "1.1.0", eventCount: 3, affectedUsers: 2 });
    expect(body.newIssues.map((i: { type: string }) => i.type)).toEqual(["NewError"]);
    expect(
      body.issues.map((row: { issue: { type: string }; events: number }) => [
        row.issue.type,
        row.events,
      ]),
    ).toEqual([
      ["NewError", 2],
      ["OldError", 1],
    ]);

    // Same release, only staging: every number agrees with that choice
    const staging = await get(owner, `/projects/${projectId}/releases/1.1.0?environment=staging`);
    expect(staging.json().issues).toHaveLength(1);
    expect(staging.json().release).toMatchObject({ eventCount: 1, affectedUsers: 1 });

    // OldError started in 1.0.0; NewError is new in 1.1.0 but only one of them hit staging
    await send(projectId, error("ProdOnlyError", "1.1.0"));
    const newInStaging = (
      await get(owner, `/projects/${projectId}/releases/1.1.0?environment=staging`)
    ).json().newIssues;
    expect(newInStaging.map((i: { type: string }) => i.type)).toEqual(["NewError"]);
  });

  it("handles versions with special characters, and unknown versions", async () => {
    const projectId = await newProject();
    await send(projectId, error("AError", "shop@2.0.0+build/7"));

    const encoded = encodeURIComponent("shop@2.0.0+build/7");
    expect((await get(owner, `/projects/${projectId}/releases/${encoded}`)).statusCode).toBe(200);

    const missing = await get(owner, `/projects/${projectId}/releases/9.9.9`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("RELEASE_NOT_FOUND");
  });
});

describe("GET /projects/:projectId/releases/compare", () => {
  it("splits issues into only-in-A, only-in-B and both", async () => {
    const projectId = await newProject();
    await send(projectId, error("FixedError", "1.0.0"));
    await send(projectId, error("StillBroken", "1.0.0"));
    await send(projectId, error("StillBroken", "2.0.0"));
    await send(projectId, error("StillBroken", "2.0.0"));
    await send(projectId, error("BrandNew", "2.0.0"));

    const res = await get(owner, `/projects/${projectId}/releases/compare?a=1.0.0&b=2.0.0`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const types = (rows: { issue: { type: string } }[]) => rows.map((row) => row.issue.type);

    expect(types(body.onlyInA)).toEqual(["FixedError"]);
    expect(types(body.onlyInB)).toEqual(["BrandNew"]);
    expect(body.inBoth).toEqual([
      expect.objectContaining({
        countA: 1,
        countB: 2,
        issue: expect.objectContaining({ type: "StillBroken" }),
      }),
    ]);
  });

  it("needs two different releases", async () => {
    const projectId = await newProject();
    const url = `/projects/${projectId}/releases/compare`;
    expect((await get(owner, `${url}?a=1.0.0`)).statusCode).toBe(400);
    expect((await get(owner, `${url}?a=1.0.0&b=1.0.0`)).json().error.code).toBe("SAME_RELEASE");
  });
});

describe("environment isolation in stats", () => {
  it("counts only the chosen environment, and reports total users", async () => {
    const projectId = await newProject();
    const now = new Date().toISOString();
    await send(projectId, error("ProdError", "1.0.0", { timestamp: now, user: { id: "1" } }));
    await send(projectId, error("ProdError", "1.0.0", { timestamp: now, user: { id: "2" } }));
    await send(
      projectId,
      error("StagingError", "1.0.0", { timestamp: now, user: { id: "3" }, environment: "staging" }),
    );

    const all = (await get(owner, `/projects/${projectId}/stats`)).json().stats;
    expect(all).toMatchObject({ activeIssues: 2, events24h: 3, users24h: 3, totalUsers: 3 });

    const prod = (await get(owner, `/projects/${projectId}/stats?environment=production`)).json()
      .stats;
    expect(prod).toMatchObject({ activeIssues: 1, events24h: 2, users24h: 2, totalUsers: 3 });

    // And the F8 issue filter agrees
    const list = await get(owner, `/projects/${projectId}/issues?environment=staging`);
    expect(list.json().issues.map((i: { type: string }) => i.type)).toEqual(["StagingError"]);

    const [prodIssue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.projectId, projectId), eq(issues.type, "ProdError")));
    expect(prodIssue?.userCount).toBe(2);
  });
});
