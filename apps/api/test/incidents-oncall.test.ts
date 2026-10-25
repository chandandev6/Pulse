import { EventSchema } from "@pulse/shared";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/client.js";
import { alertRules, incidents, notificationLog } from "../src/db/schema.js";
import { saveEvent } from "../src/events/store.js";
import { planIncidentNotifications } from "../src/notifications/dispatch.js";
import { addMember, createTestUser, deleteTestUsers } from "./helpers.js";

// The real path (no mocks): project → its on-call schedule (F12) → first responder (F13)

const app = buildApp();

const PREFIX = "oncallinc-";
const run = Date.now();
const email = (name: string) => `${PREFIX}${name}-${run}@example.com`;

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let projectId: string;

function as(user: TestUser, method: "GET" | "POST" | "PATCH", url: string, body?: object) {
  return app.inject({ method, url, cookies: user.cookies, payload: body });
}

async function newSchedule(user: TestUser, participants: string[]) {
  const created = await as(user, "POST", `/orgs/${user.org.id}/schedules`, {
    name: `Primary ${crypto.randomUUID().slice(0, 6)}`,
    timezone: "UTC",
  });
  expect(created.statusCode).toBe(201);
  const scheduleId = created.json().schedule.id as string;
  const layer = await as(user, "POST", `/schedules/${scheduleId}/layers`, {
    name: "Base",
    rotationType: "weekly",
    handoffTime: "09:00",
    startDate: "2026-01-01",
    participants,
  });
  expect(layer.statusCode).toBe(201);
  return scheduleId;
}

beforeAll(async () => {
  await app.ready();
  owner = await createTestUser(email("owner"), "Owner");
  member = await createTestUser(email("member"), "Member");
  outsider = await createTestUser(email("outsider"), "Outsider");
  await addMember(owner.org.id, member.user.id);

  const created = await as(owner, "POST", `/orgs/${owner.org.id}/projects`, { name: "Shop" });
  projectId = created.json().project.id;
  await db.insert(alertRules).values({
    projectId,
    name: "Every new issue",
    conditions: [{ type: "new_issue" }],
    severity: "high",
  });
});

afterAll(async () => {
  await deleteTestUsers(PREFIX);
  await app.close();
});

describe("project on-call schedule", () => {
  it("only accepts a schedule of the project's own org", async () => {
    const theirs = await newSchedule(outsider, [outsider.user.id]);
    const res = await as(owner, "PATCH", `/projects/${projectId}`, { onCallScheduleId: theirs });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_SCHEDULE");
  });

  it("makes whoever is on call the first responder", async () => {
    // One person in the rotation: always on call
    const scheduleId = await newSchedule(owner, [member.user.id]);
    const set = await as(owner, "PATCH", `/projects/${projectId}`, {
      onCallScheduleId: scheduleId,
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().project.onCallScheduleId).toBe(scheduleId);

    const saved = await saveEvent({
      projectId,
      receivedAt: new Date().toISOString(),
      event: EventSchema.parse({ exception: { type: "OnCallError", value: "boom" } }),
    });
    const incidentId = saved?.incidentIds[0];
    if (!incidentId) throw new Error("incident not opened");

    const deliveryIds = await planIncidentNotifications(incidentId);
    const planned = await db
      .select({ recipient: notificationLog.recipient })
      .from(notificationLog)
      .where(inArray(notificationLog.id, deliveryIds));
    // Only the member's account email: the owner isn't on call
    expect(planned.map((row) => row.recipient)).toEqual([member.user.email]);

    const [incident] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
    expect(incident?.responderId).toBe(member.user.id);

    const detail = await as(owner, "GET", `/incidents/${incidentId}`);
    expect(detail.json().incident.responder).toEqual({ id: member.user.id, name: "Member" });
    const notified = detail.json().timeline.find((s: { kind: string }) => s.kind === "notified");
    expect(notified.data.responder).toMatchObject({ name: "Member", source: "layer" });
  });

  it("can be cleared", async () => {
    const res = await as(owner, "PATCH", `/projects/${projectId}`, { onCallScheduleId: null });
    expect(res.json().project.onCallScheduleId).toBeNull();
  });
});
