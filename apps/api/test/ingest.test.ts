import type { Worker } from "bullmq";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/client.js";
import { events } from "../src/db/schema.js";
import { saveEvent } from "../src/events/store.js";
import { createEventWorker } from "../src/events/worker.js";
import { createTestUser, deleteTestUsers } from "./helpers.js";

const app = buildApp();

const PREFIX = "ingesttest-";
const run = Date.now();

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
let owner: TestUser;
let worker: Worker;
let projectId: string;
let key: string;
let otherProjectId: string;

const randomEventId = () => crypto.randomUUID().replaceAll("-", "");

function send(body: unknown, options: { key?: string; project?: string } = {}) {
  return app.inject({
    method: "POST",
    url: `/api/${options.project ?? projectId}/events`,
    headers: options.key === "" ? {} : { "x-pulse-key": options.key ?? key },
    payload: body as object,
  });
}

// The worker saves events in the background, so poll the database until it shows up
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

beforeAll(async () => {
  await app.ready();
  worker = createEventWorker();
  owner = await createTestUser(`${PREFIX}owner-${run}@example.com`, "Owner");
  ({ id: projectId, key } = await createProject("Shop"));
  ({ id: otherProjectId } = await createProject("Blog"));
});

afterAll(async () => {
  await worker.close();
  await deleteTestUsers(PREFIX); // events cascade with their projects
  await app.close();
});

describe("POST /api/:projectId/events", () => {
  it("accepts a valid event fast and the worker stores every field", async () => {
    const eventId = randomEventId();
    const res = await send({
      event_id: eventId,
      timestamp: "2026-10-22T10:00:00.000Z",
      level: "fatal",
      exception: {
        type: "TypeError",
        value: "Cannot read properties of undefined (reading 'name')",
        stacktrace: { frames: [{ filename: "app.js", function: "checkout", lineno: 42 }] },
      },
      environment: "staging",
      release: "1.4.2",
      user: { id: "42", email: "ada@example.com" },
      request: { method: "GET", url: "https://shop.example.com/checkout", route: "/checkout" },
      tags: { browser: "Firefox" },
      context: { cartSize: 3 },
      sdk: { name: "pulse-js", version: "0.1.0" },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ id: eventId });

    const row = await waitForEvent(eventId);
    expect(row.timestamp.toISOString()).toBe("2026-10-22T10:00:00.000Z");
    expect(row.level).toBe("fatal");
    expect(row.type).toBe("TypeError");
    expect(row.message).toBe("Cannot read properties of undefined (reading 'name')");
    expect(row.stacktrace).toEqual({
      frames: [{ filename: "app.js", function: "checkout", lineno: 42 }],
    });
    expect(row.environment).toBe("staging");
    expect(row.release).toBe("1.4.2");
    expect(row.user).toEqual({ id: "42", email: "ada@example.com" });
    expect(row.request).toMatchObject({ route: "/checkout" });
    expect(row.tags).toEqual({ browser: "Firefox" });
    expect(row.context).toEqual({ cartSize: 3 });
    expect(row.sdk).toEqual({ name: "pulse-js", version: "0.1.0" });
    expect(row.issueId).toBeNull(); // grouping comes in F4
  });

  it("fills in defaults for a minimal event", async () => {
    const res = await send({ message: "Something odd happened" });

    expect(res.statusCode).toBe(202);
    const { id } = res.json();
    expect(id).toMatch(/^[a-f0-9]{32}$/);

    const row = await waitForEvent(id);
    expect(row.message).toBe("Something odd happened");
    expect(row.environment).toBe("production");
    expect(row.level).toBe("error");
  });

  it("also accepts the key in the query string (for browser beacons)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/${projectId}/events?pulse_key=${key}`,
      payload: { message: "via beacon" },
    });
    expect(res.statusCode).toBe(202);
  });

  it("rejects missing, wrong, other-project and malformed keys with 401", async () => {
    const attempts = [
      send({ message: "x" }, { key: "" }),
      send({ message: "x" }, { key: "0".repeat(32) }),
      send({ message: "x" }, { project: otherProjectId }), // valid key, wrong project
      send({ message: "x" }, { project: "not-a-uuid" }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("INVALID_KEY");
    }
  });

  it("rejects a revoked key with 401", async () => {
    const project = await createProject("Rotating");
    const before = await send({ message: "before" }, { key: project.key, project: project.id });
    expect(before.statusCode).toBe(202);

    await app.inject({
      method: "POST",
      url: `/projects/${project.id}/keys/rotate`,
      cookies: owner.cookies,
    });

    const res = await send({ message: "after" }, { key: project.key, project: project.id });
    expect(res.statusCode).toBe(401);
  });

  it("rejects bad payloads with 400", async () => {
    const bad = [
      {}, // no message or exception
      { message: "x", level: "panic" },
      { message: "x", event_id: "not-hex" },
      { exception: { value: "missing type" } },
    ];
    for (const body of bad) {
      const res = await send(body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("refuses events over the size limit with 413", async () => {
    const res = await send({ message: "x", context: { blob: "a".repeat(300 * 1024) } });
    expect(res.statusCode).toBe(413);
  });

  it("answers CORS preflights so browsers can report", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: `/api/${projectId}/events`,
      headers: {
        origin: "https://shop.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-pulse-key",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");

    // ...but dashboard routes stay closed to other websites
    const health = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.example.com" },
    });
    expect(health.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("idempotency", () => {
  it("stores an event sent twice only once", async () => {
    const eventId = randomEventId();
    const job = {
      projectId,
      receivedAt: new Date().toISOString(),
      event: {
        event_id: eventId,
        timestamp: new Date().toISOString(),
        level: "error" as const,
        message: "retried",
        environment: "production",
      },
    };

    expect(await saveEvent(job)).not.toBeNull();
    expect(await saveEvent(job)).toBeNull(); // duplicate, skipped

    const rows = await db
      .select()
      .from(events)
      .where(and(eq(events.projectId, projectId), eq(events.eventId, eventId)));
    expect(rows).toHaveLength(1);
  });
});
