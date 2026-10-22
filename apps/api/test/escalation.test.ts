import { EventSchema } from "@pulse/shared";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/client.js";
import {
  alertRules,
  escalationTargets,
  incidents,
  incidentTimeline,
  memberships,
  notificationLog,
} from "../src/db/schema.js";
import { levelForStep } from "../src/escalation/steps.js";
import { saveEvent } from "../src/events/store.js";
import type { ChannelType } from "../src/notifications/channels.js";
import type { NotificationMessage } from "../src/notifications/message.js";
import type { Notifier, NotifierRegistry } from "../src/notifications/notifier.js";
import { notificationsQueue } from "../src/notifications/queue.js";
import { handleNotificationJob } from "../src/notifications/worker.js";
import { createTestUser, deleteTestUsers } from "./helpers.js";

const app = buildApp();

const PREFIX = "escalationtest-";
const run = Date.now();
const email = (name: string) => `${PREFIX}${name}-${run}@example.com`;
const MINUTE = 60_000;

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
let owner: TestUser;
let ben: TestUser;
let cara: TestUser;
let outsider: TestUser;
let projectId: string;
let scheduleId: string; // Cara is always on call here

// Nothing really goes to Redis: we look at what *would* be queued
const added = vi.spyOn(notificationsQueue, "add").mockResolvedValue({} as never);
const addedBulk = vi.spyOn(notificationsQueue, "addBulk").mockResolvedValue([]);
const removed = vi.spyOn(notificationsQueue, "remove").mockResolvedValue(1);

function as(
  user: TestUser,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: object,
) {
  return app.inject({ method, url, cookies: user.cookies, payload: body });
}

// Notifiers that remember what they were asked to send
const sent: { type: ChannelType; message: NotificationMessage }[] = [];
const fake = <T extends ChannelType>(type: T): Notifier<T> => ({
  isConfigured: () => true,
  send: async (_recipient, message) => {
    sent.push({ type, message });
  },
});
const notifiers: NotifierRegistry = {
  email: fake("email"),
  sms: fake("sms"),
  push: fake("push"),
  webhook: fake("webhook"),
};
const runJob = (data: Parameters<typeof handleNotificationJob>[0]) =>
  handleNotificationJob(data, { attemptsMade: 0, attempts: 6 }, notifiers);

// Level 1: Ben for 5 minutes. Level 2: whoever is on call (Cara) for 10 minutes. Then once more.
const standardLevels = () => [
  { timeoutMinutes: 5, targets: [{ type: "user", id: ben.user.id }] },
  { timeoutMinutes: 10, targets: [{ type: "schedule", id: scheduleId }] },
];

async function newPolicy(levels = standardLevels(), repeatCount = 1) {
  const res = await as(owner, "POST", `/orgs/${owner.org.id}/escalation-policies`, {
    name: `Checkout ${crypto.randomUUID().slice(0, 6)}`,
    repeatCount,
    levels,
  });
  expect(res.statusCode).toBe(201);
  return res.json().policy.id as string;
}

// A rule using the policy, and an error that fires it
async function newIncident(policyId: string | null) {
  const created = await as(owner, "POST", `/projects/${projectId}/alert-rules`, {
    name: `Rule ${crypto.randomUUID().slice(0, 6)}`,
    conditions: [{ type: "new_issue" }],
    severity: "high",
    escalationPolicyId: policyId,
  });
  expect(created.statusCode).toBe(201);
  const saved = await saveEvent({
    projectId,
    receivedAt: new Date().toISOString(),
    event: EventSchema.parse({
      exception: { type: `Error${crypto.randomUUID().slice(0, 8)}`, value: "boom" },
    }),
  });
  // Only this rule's incident: disable it so the next test's event doesn't fire it again
  await db
    .update(alertRules)
    .set({ enabled: false })
    .where(eq(alertRules.id, created.json().rule.id));
  const incidentId = saved?.incidentIds[0];
  if (!incidentId) throw new Error("incident not opened");
  return incidentId;
}

const incidentRow = async (id: string) =>
  (await db.select().from(incidents).where(eq(incidents.id, id)))[0];

const timelineOf = (id: string) =>
  db
    .select()
    .from(incidentTimeline)
    .where(eq(incidentTimeline.incidentId, id))
    .orderBy(incidentTimeline.createdAt);

const recipientsOf = async (deliveryIds: string[]) =>
  deliveryIds.length
    ? (
        await db
          .select({ recipient: notificationLog.recipient })
          .from(notificationLog)
          .where(inArray(notificationLog.id, deliveryIds))
      ).map((row) => row.recipient)
    : [];

// The deliveries the last job queued (enqueueDeliveries → addBulk)
const lastQueuedDeliveries = () =>
  (addedBulk.mock.lastCall?.[0] ?? []).map(
    (job) => (job.data as { deliveryId: string }).deliveryId,
  );

beforeAll(async () => {
  await app.ready();
  owner = await createTestUser(email("owner"), "Owner");
  ben = await createTestUser(email("ben"), "Ben");
  cara = await createTestUser(email("cara"), "Cara");
  outsider = await createTestUser(email("outsider"), "Outsider");
  for (const user of [ben, cara]) {
    await as(owner, "POST", `/orgs/${owner.org.id}/members`, { email: user.user.email });
  }

  const project = await as(owner, "POST", `/orgs/${owner.org.id}/projects`, { name: "Shop" });
  projectId = project.json().project.id;

  const schedule = await as(owner, "POST", `/orgs/${owner.org.id}/schedules`, {
    name: "Primary",
    timezone: "UTC",
  });
  scheduleId = schedule.json().schedule.id;
  await as(owner, "POST", `/schedules/${scheduleId}/layers`, {
    name: "Base",
    rotationType: "weekly",
    handoffTime: "09:00",
    startDate: "2026-01-01",
    participants: [cara.user.id],
  });
});

afterEach(() => {
  vi.useRealTimers();
  added.mockClear();
  addedBulk.mockClear();
  removed.mockClear();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await deleteTestUsers(PREFIX);
  await app.close();
});

describe("levelForStep", () => {
  it("walks the levels, repeats, then stops", () => {
    // 3 levels, 1 repeat
    const walk = [0, 1, 2, 3, 4, 5, 6].map((step) => levelForStep(3, 1, step));
    expect(walk).toEqual([
      { levelIndex: 0, pass: 0 },
      { levelIndex: 1, pass: 0 },
      { levelIndex: 2, pass: 0 },
      { levelIndex: 0, pass: 1 },
      { levelIndex: 1, pass: 1 },
      { levelIndex: 2, pass: 1 },
      null,
    ]);
    expect(levelForStep(0, 0, 0)).toBeNull();
  });
});

describe("policies", () => {
  it("saves levels in order with names, and counts the rules using it", async () => {
    const policyId = await newPolicy();
    await newIncident(policyId);

    const res = await as(ben, "GET", `/escalation-policies/${policyId}`);
    expect(res.statusCode).toBe(200);
    const { policy, rules } = res.json();
    expect(policy.repeatCount).toBe(1);
    expect(policy.levels).toMatchObject([
      { position: 0, timeoutMinutes: 5, targets: [{ type: "user", id: ben.user.id, name: "Ben" }] },
      {
        position: 1,
        timeoutMinutes: 10,
        targets: [{ type: "schedule", id: scheduleId, name: "Primary" }],
      },
    ]);
    expect(rules).toHaveLength(1);

    const list = await as(ben, "GET", `/orgs/${owner.org.id}/escalation-policies`);
    expect(list.json().policies.find((p: { id: string }) => p.id === policyId).ruleCount).toBe(1);
  });

  it("reorders levels by saving the list in its new order", async () => {
    const policyId = await newPolicy();
    const [first, second] = standardLevels();
    const res = await as(owner, "PATCH", `/escalation-policies/${policyId}`, {
      levels: [second, first],
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json().policy.levels.map((l: { timeoutMinutes: number }) => l.timeoutMinutes),
    ).toEqual([10, 5]);
  });

  it("checks who can change them and what they contain", async () => {
    const url = `/orgs/${owner.org.id}/escalation-policies`;
    const body = { name: "X", levels: standardLevels() };
    expect((await as(ben, "POST", url, body)).statusCode).toBe(403);
    expect((await as(outsider, "GET", url)).statusCode).toBe(404);

    const notMember = await as(owner, "POST", url, {
      name: "X",
      levels: [{ timeoutMinutes: 5, targets: [{ type: "user", id: outsider.user.id }] }],
    });
    expect(notMember.json().error.code).toBe("NOT_A_MEMBER");

    const theirSchedule = (
      await as(outsider, "POST", `/orgs/${outsider.org.id}/schedules`, {
        name: "Theirs",
        timezone: "UTC",
      })
    ).json().schedule.id;
    const otherSchedule = await as(owner, "POST", url, {
      name: "X",
      levels: [{ timeoutMinutes: 5, targets: [{ type: "schedule", id: theirSchedule }] }],
    });
    expect(otherSchedule.json().error.code).toBe("INVALID_SCHEDULE");

    for (const levels of [
      [],
      [{ timeoutMinutes: 5, targets: [] }],
      [{ timeoutMinutes: 0, targets: [{ type: "user", id: ben.user.id }] }],
    ]) {
      expect((await as(owner, "POST", url, { name: "X", levels })).statusCode).toBe(400);
    }

    const policyId = await newPolicy();
    expect((await as(outsider, "GET", `/escalation-policies/${policyId}`)).statusCode).toBe(404);
    expect((await as(ben, "DELETE", `/escalation-policies/${policyId}`)).statusCode).toBe(403);
  });

  it("only lets a rule use a policy of its own org", async () => {
    const theirs = (
      await as(outsider, "POST", `/orgs/${outsider.org.id}/escalation-policies`, {
        name: "Theirs",
        levels: [{ timeoutMinutes: 5, targets: [{ type: "user", id: outsider.user.id }] }],
      })
    ).json().policy.id;
    const res = await as(owner, "POST", `/projects/${projectId}/alert-rules`, {
      name: "Sneaky",
      conditions: [{ type: "new_issue" }],
      severity: "high",
      escalationPolicyId: theirs,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_POLICY");
  });
});

describe("escalation", () => {
  it("walks through every level on time, repeats, then gives up", async () => {
    // Only the clock is fake: the database and HTTP keep working
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-10-22T10:00:00Z");
    vi.setSystemTime(start);

    const policyId = await newPolicy();
    const incidentId = await newIncident(policyId);
    expect((await incidentRow(incidentId))?.escalationPolicyId).toBe(policyId);

    // Opening: level 1 (Ben), next level due in 5 minutes
    await runJob({ kind: "incident", incidentId });
    expect(await recipientsOf(lastQueuedDeliveries())).toEqual([ben.user.email]);
    expect(added).toHaveBeenLastCalledWith(
      "escalate",
      { kind: "escalate", incidentId, step: 1 },
      { jobId: `escalate-${incidentId}-1`, delay: 5 * MINUTE },
    );
    expect((await incidentRow(incidentId))?.responderId).toBe(ben.user.id);

    // 5 minutes later, nobody acknowledged: level 2 (Cara, on call), next in 10 minutes
    vi.setSystemTime(new Date(start.getTime() + 5 * MINUTE));
    await runJob({ kind: "escalate", incidentId, step: 1 });
    expect(await recipientsOf(lastQueuedDeliveries())).toEqual([cara.user.email]);
    expect(added.mock.lastCall?.[2]).toMatchObject({ delay: 10 * MINUTE });

    // The same job again (a retry, or a duplicate): nothing happens
    addedBulk.mockClear();
    await runJob({ kind: "escalate", incidentId, step: 1 });
    expect(lastQueuedDeliveries()).toEqual([]);

    // The repeat: Ben, then Cara again
    vi.setSystemTime(new Date(start.getTime() + 15 * MINUTE));
    await runJob({ kind: "escalate", incidentId, step: 2 });
    expect(await recipientsOf(lastQueuedDeliveries())).toEqual([ben.user.email]);
    vi.setSystemTime(new Date(start.getTime() + 20 * MINUTE));
    await runJob({ kind: "escalate", incidentId, step: 3 });
    expect(await recipientsOf(lastQueuedDeliveries())).toEqual([cara.user.email]);

    // Every level, twice: give up, schedule nothing more
    added.mockClear();
    vi.setSystemTime(new Date(start.getTime() + 30 * MINUTE));
    await runJob({ kind: "escalate", incidentId, step: 4 });
    expect(added).not.toHaveBeenCalled();
    const incident = await incidentRow(incidentId);
    expect(incident).toMatchObject({
      escalationStep: 4,
      nextEscalationAt: null,
      status: "triggered",
    });

    // The history says who was contacted, and when
    const timeline = await timelineOf(incidentId);
    expect(timeline.map((step) => step.kind)).toEqual([
      "triggered",
      "notified",
      "escalated",
      "escalated",
      "escalated",
      "exhausted",
    ]);
    expect(timeline[1]?.data).toMatchObject({
      escalation: { targets: [{ id: ben.user.id, name: "Ben", schedule: null }] },
    });
    expect(timeline[2]?.data).toEqual({
      step: 1,
      level: 2,
      pass: 1,
      targets: [{ id: cara.user.id, name: "Cara", schedule: { id: scheduleId, name: "Primary" } }],
      channels: 1,
    });
    expect(timeline[3]?.data).toMatchObject({ step: 2, level: 1, pass: 2 });
    expect(timeline[2]?.createdAt.getTime()).toBe(start.getTime() + 5 * MINUTE);
    expect(timeline[5]?.data).toEqual({ levels: 2, passes: 2 });
  });

  it("says ESCALATED in the message", async () => {
    const policyId = await newPolicy();
    const incidentId = await newIncident(policyId);
    await runJob({ kind: "incident", incidentId });
    await runJob({ kind: "escalate", incidentId, step: 1 });
    sent.length = 0;
    for (const deliveryId of lastQueuedDeliveries()) {
      await runJob({ kind: "deliver", deliveryId });
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.subject).toMatch(/^\[HIGH\] ESCALATED Shop: /);
    expect(sent[0]?.message.payload.type).toBe("incident.escalated");
  });

  it("stops immediately when someone acknowledges", async () => {
    const policyId = await newPolicy();
    const incidentId = await newIncident(policyId);
    await runJob({ kind: "incident", incidentId });

    const ack = await as(ben, "POST", `/incidents/${incidentId}/acknowledge`);
    expect(ack.statusCode).toBe(200);
    expect(removed).toHaveBeenCalledWith(`escalate-${incidentId}-1`);
    expect((await incidentRow(incidentId))?.nextEscalationAt).toBeNull();

    // Even if the delayed job still runs, it does nothing
    addedBulk.mockClear();
    added.mockClear();
    await runJob({ kind: "escalate", incidentId, step: 1 });
    expect(lastQueuedDeliveries()).toEqual([]);
    expect(added).not.toHaveBeenCalled();
    const kinds = (await timelineOf(incidentId)).map((step) => step.kind);
    expect(kinds).not.toContain("escalated");
  });

  it("stops when it's resolved, and shows its place in the detail", async () => {
    const policyId = await newPolicy();
    const incidentId = await newIncident(policyId);
    await runJob({ kind: "incident", incidentId });
    await runJob({ kind: "escalate", incidentId, step: 1 });

    const detail = await as(owner, "GET", `/incidents/${incidentId}`);
    expect(detail.json().incident).toMatchObject({
      escalationPolicy: { id: policyId },
      escalationStep: 1,
    });
    expect(detail.json().incident.nextEscalationAt).not.toBeNull();

    await as(owner, "POST", `/incidents/${incidentId}/resolve`);
    expect(removed).toHaveBeenCalledWith(`escalate-${incidentId}-2`);
    expect((await incidentRow(incidentId))?.nextEscalationAt).toBeNull();
  });

  it("keeps the project's on-call behaviour for rules without a policy", async () => {
    const incidentId = await newIncident(null);
    await runJob({ kind: "incident", incidentId });
    expect(added).not.toHaveBeenCalled();
    expect((await incidentRow(incidentId))?.nextEscalationAt).toBeNull();
  });

  it("stops escalating when its policy is deleted", async () => {
    const policyId = await newPolicy();
    const incidentId = await newIncident(policyId);
    await runJob({ kind: "incident", incidentId });
    expect((await as(owner, "DELETE", `/escalation-policies/${policyId}`)).statusCode).toBe(204);

    added.mockClear();
    addedBulk.mockClear();
    await runJob({ kind: "escalate", incidentId, step: 1 });
    expect(lastQueuedDeliveries()).toEqual([]);
    expect(added).not.toHaveBeenCalled();
    expect((await incidentRow(incidentId))?.nextEscalationAt).toBeNull();
  });

  it("forgets people who leave the org", async () => {
    const dan = await createTestUser(email("dan"), "Dan");
    await as(owner, "POST", `/orgs/${owner.org.id}/members`, { email: dan.user.email });
    await newPolicy([{ timeoutMinutes: 5, targets: [{ type: "user", id: dan.user.id }] }], 0);

    const res = await as(owner, "DELETE", `/orgs/${owner.org.id}/members/${dan.user.id}`);
    expect(res.statusCode).toBe(204);
    const left = await db
      .select()
      .from(escalationTargets)
      .where(eq(escalationTargets.userId, dan.user.id));
    expect(left).toEqual([]);
    const still = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, owner.org.id), eq(memberships.userId, dan.user.id)));
    expect(still).toEqual([]);
  });
});
