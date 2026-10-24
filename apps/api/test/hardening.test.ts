import { EventSchema } from "@pulse/shared";
import type { Worker } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/client.js";
import { auditLog, events } from "../src/db/schema.js";
import { checkIngestLimits, quotaKeys } from "../src/events/quota.js";
import { FILTERED, scrubEvent } from "../src/events/scrub.js";
import { saveEvent } from "../src/events/store.js";
import { createEventWorker } from "../src/events/worker.js";
import { redis } from "../src/redis.js";
import { runRetention } from "../src/retention/retention.js";
import { createTestUser, deleteTestUsers } from "./helpers.js";

const app = buildApp();

const PREFIX = "hardentest-";
const run = Date.now();

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
let owner: TestUser;
let member: TestUser;
let projectId: string;
let key: string;
let worker: Worker;

const randomEventId = () => crypto.randomUUID().replaceAll("-", "");

function send(body: object, project = projectId, projectKey = key) {
  return app.inject({
    method: "POST",
    url: `/api/${project}/events`,
    headers: { "x-pulse-key": projectKey },
    payload: body,
  });
}

async function createProject(name: string) {
  const res = await app.inject({
    method: "POST",
    url: `/orgs/${owner.org.id}/projects`,
    cookies: owner.cookies,
    payload: { name },
  });
  const { project } = res.json();
  return { id: project.id as string, key: new URL(project.dsn).username };
}

function patchProject(id: string, payload: object, user = owner) {
  return app.inject({ method: "PATCH", url: `/projects/${id}`, cookies: user.cookies, payload });
}

async function waitForEvent(eventId: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.projectId, projectId), eq(events.eventId, eventId)));
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Event ${eventId} was not saved within ${timeoutMs}ms`);
}

async function clearIngestCounters(id: string) {
  const keys = quotaKeys(id, new Date());
  await redis.del(keys.minute, keys.month);
}

beforeAll(async () => {
  await app.ready();
  worker = createEventWorker();
  owner = await createTestUser(`${PREFIX}owner-${run}@example.com`, "Owner");
  member = await createTestUser(`${PREFIX}member-${run}@example.com`, "Member");
  await app.inject({
    method: "POST",
    url: `/orgs/${owner.org.id}/members`,
    cookies: owner.cookies,
    payload: { email: member.user.email, role: "member" },
  });
  ({ id: projectId, key } = await createProject("Hardened"));
});

afterAll(async () => {
  await worker.close();
  await clearIngestCounters(projectId);
  await deleteTestUsers(PREFIX); // audit rows cascade with the orgs
  await app.close();
});

describe("scrubEvent", () => {
  const base = EventSchema.parse({ message: "boom" });
  const options = { fields: [], ipAddresses: false };

  it("filters sensitive keys in headers, context and tags, at any depth", () => {
    const event = scrubEvent(
      {
        ...base,
        request: {
          headers: { Authorization: "Bearer abc", Cookie: "sid=1", Accept: "text/html" },
        },
        context: { form: { email: "a@b.c", userPassword: "hunter2", items: [{ apiKey: "k" }] } },
        tags: { session_id: "s1", browser: "Firefox" },
      },
      options,
    );
    expect(event.request?.headers).toEqual({
      Authorization: FILTERED,
      Cookie: FILTERED,
      Accept: "text/html",
    });
    expect(event.context).toEqual({
      form: { email: "a@b.c", userPassword: FILTERED, items: [{ apiKey: FILTERED }] },
    });
    expect(event.tags).toEqual({ session_id: FILTERED, browser: "Firefox" });
  });

  it("filters query string secrets, bearer tokens and card numbers in text", () => {
    const event = scrubEvent(
      {
        ...base,
        message: "charge 4242 4242 4242 4242 failed at 1761300000000 with Bearer eyJhbGc.x.y",
        request: { url: "https://x.com/cb?token=abc&page=2#top" },
      },
      options,
    );
    expect(event.request?.url).toBe(`https://x.com/cb?token=${FILTERED}&page=2#top`);
    // The card passes the Luhn check; the millisecond timestamp doesn't, so it stays
    expect(event.message).toBe(`charge ${FILTERED} failed at 1761300000000 with ${FILTERED}`);
  });

  it("uses the project's extra fields and can drop IP addresses", () => {
    const event = scrubEvent(
      { ...base, context: { iban: "DE89", note: "ok" }, user: { id: "1", ip: "1.2.3.4" } },
      { fields: ["IBAN"], ipAddresses: true },
    );
    expect(event.context).toEqual({ iban: FILTERED, note: "ok" });
    expect(event.user).toEqual({ id: "1" });
  });
});

describe("project settings", () => {
  it("admins change limits, retention and scrubbing; members can't", async () => {
    const res = await patchProject(projectId, {
      retentionDays: 30,
      monthlyQuota: 1000,
      scrubFields: ["iban", "iban"],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().project).toMatchObject({
      retentionDays: 30,
      monthlyQuota: 1000,
      scrubFields: ["iban"],
      scrubData: true,
    });

    expect((await patchProject(projectId, { retentionDays: 0 })).statusCode).toBe(400);
    expect((await patchProject(projectId, { retentionDays: 7 }, member)).statusCode).toBe(403);
  });

  it("GET /projects/:id shows this month's usage", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/projects/${projectId}`,
      cookies: owner.cookies,
    });
    expect(res.json().usage).toEqual({ eventsThisMonth: expect.any(Number) });
  });
});

describe("ingestion limits", () => {
  it("answers 429 with Retry-After once the per-minute limit is used up", async () => {
    await clearIngestCounters(projectId);
    await patchProject(projectId, { rateLimitPerMinute: 2, monthlyQuota: null });

    expect((await send({ message: "one" })).statusCode).toBe(202);
    expect((await send({ message: "two" })).statusCode).toBe(202);
    const limited = await send({ message: "three" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("PROJECT_RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("invalid events don't count", async () => {
    await clearIngestCounters(projectId);
    await patchProject(projectId, { rateLimitPerMinute: 1 });
    expect((await send({ level: "error" })).statusCode).toBe(400); // no message
    expect((await send({ message: "valid" })).statusCode).toBe(202);
  });

  it("enforces the monthly quota; rate-limited events don't use it up", async () => {
    const project = { id: projectId, rateLimitPerMinute: 1, monthlyQuota: 2 };
    const now = new Date();
    const keys = quotaKeys(projectId, now);
    await redis.del(keys.minute, keys.month);

    await checkIngestLimits(project, now); // minute 1/1, month 1/2
    await expect(checkIngestLimits(project, now)).rejects.toMatchObject({
      code: "PROJECT_RATE_LIMITED",
    });
    expect(Number(await redis.get(keys.month))).toBe(1);

    const roomy = { ...project, rateLimitPerMinute: 100 };
    await checkIngestLimits(roomy, now); // month 2/2
    await expect(checkIngestLimits(roomy, now)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
      retryAfter: expect.any(Number),
    });
    expect(Number(await redis.get(keys.month))).toBe(2); // the refused one was undone
  });

  it("scrubs before the event is stored", async () => {
    await clearIngestCounters(projectId);
    await patchProject(projectId, { rateLimitPerMinute: 1000 });
    const eventId = randomEventId();
    const res = await send({
      event_id: eventId,
      message: "login failed",
      request: { headers: { cookie: "sid=secret" } },
      context: { password: "hunter2" },
    });
    expect(res.statusCode).toBe(202);

    // The worker stores what the API queued: already scrubbed
    const stored = await waitForEvent(eventId);
    expect(stored.request).toEqual({ headers: { cookie: FILTERED } });
    expect(stored.context).toEqual({ password: FILTERED });
    expect(stored.message).toBe("login failed");
  });
});

describe("retention", () => {
  it("deletes events older than the project's retention, keeps newer ones", async () => {
    const { id } = await createProject("Retained");
    await patchProject(id, { retentionDays: 7 });
    const now = new Date();
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

    const old = randomEventId();
    const recent = randomEventId();
    for (const [eventId, timestamp] of [
      [old, daysAgo(8)],
      [recent, daysAgo(6)],
    ] as const) {
      await saveEvent({
        projectId: id,
        receivedAt: now.toISOString(),
        event: EventSchema.parse({ event_id: eventId, timestamp, message: "retention check" }),
      });
    }

    const result = await runRetention(now);
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const left = await db
      .select({ eventId: events.eventId })
      .from(events)
      .where(and(eq(events.projectId, id), inArray(events.eventId, [old, recent])));
    expect(left.map((row) => row.eventId)).toEqual([recent]);
  });
});

describe("audit log", () => {
  const listAudit = (user: TestUser, query = "") =>
    app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/audit-log${query}`,
      cookies: user.cookies,
    });

  it("records sensitive actions with who did them", async () => {
    await app.inject({
      method: "POST",
      url: `/projects/${projectId}/keys/rotate`,
      cookies: owner.cookies,
    });
    const res = await listAudit(owner, "?action=key.rotated");
    expect(res.statusCode).toBe(200);
    const [entry] = res.json().entries;
    expect(entry).toMatchObject({
      action: "key.rotated",
      targetType: "project",
      targetId: projectId,
      actor: { id: owner.user.id, email: owner.user.email },
    });

    const actions = (await listAudit(owner, "?limit=100"))
      .json()
      .entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["member.added", "project.created", "project.updated"]),
    );
  });

  it("stores the names of changed fields, not their values", async () => {
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, owner.org.id), eq(auditLog.action, "project.updated")))
      .limit(1);
    expect(row?.data).toEqual({ fields: expect.any(Array) });
  });

  it("pages with a cursor", async () => {
    const first = (await listAudit(owner, "?limit=1")).json();
    expect(first.entries).toHaveLength(1);
    const second = (await listAudit(owner, `?limit=1&cursor=${first.nextCursor}`)).json();
    expect(second.entries[0].id).not.toBe(first.entries[0].id);
  });

  it("is for admins only", async () => {
    expect((await listAudit(member)).statusCode).toBe(403);
  });
});
