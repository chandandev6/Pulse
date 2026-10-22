import { EventSchema } from "@pulse/shared";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/client.js";
import {
  alertRules,
  incidents,
  incidentTimeline,
  issueActivity,
  issues,
  memberships,
  notificationChannels,
  notificationLog,
  projects,
} from "../src/db/schema.js";
import { saveEvent } from "../src/events/store.js";
import { getFirstResponder } from "../src/incidents/responder.js";
import { planIncidentNotifications } from "../src/notifications/dispatch.js";
import { createAckToken } from "../src/notifications/links.js";
import { createTestUser, deleteTestUsers } from "./helpers.js";

// Nobody is on call unless a test says so (F12 provides the real answer)
vi.mock("../src/incidents/responder.js", () => ({ getFirstResponder: vi.fn(async () => null) }));

const app = buildApp();

const PREFIX = "incidenttest-";
const run = Date.now();
const email = (name: string) => `${PREFIX}${name}-${run}@example.com`;

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let projectId: string;

function as(user: TestUser | null, method: "GET" | "POST", url: string, body?: object) {
  return app.inject({ method, url, cookies: user?.cookies, payload: body });
}

// A new issue in the owner's project, which the project's "new issue" rule turns into an incident
async function newIncident() {
  const saved = await saveEvent({
    projectId,
    receivedAt: new Date().toISOString(),
    event: EventSchema.parse({
      // A different type each time, so every event is a new issue
      exception: { type: `Error${crypto.randomUUID().slice(0, 8)}`, value: "boom" },
    }),
  });
  const incidentId = saved?.incidentIds[0];
  if (!incidentId) throw new Error("incident not opened");
  return incidentId;
}

const timelineOf = (incidentId: string) =>
  db
    .select()
    .from(incidentTimeline)
    .where(eq(incidentTimeline.incidentId, incidentId))
    .orderBy(incidentTimeline.createdAt);

beforeAll(async () => {
  await app.ready();
  owner = await createTestUser(email("owner"), "Owner");
  member = await createTestUser(email("member"), "Member");
  outsider = await createTestUser(email("outsider"), "Outsider");
  await as(owner, "POST", `/orgs/${owner.org.id}/members`, { email: member.user.email });

  const [project] = await db
    .insert(projects)
    .values({ orgId: owner.org.id, name: "Shop", slug: crypto.randomUUID(), platform: "node" })
    .returning();
  if (!project) throw new Error("project not created");
  projectId = project.id;
  await db.insert(alertRules).values({
    projectId,
    name: "Every new issue",
    conditions: [{ type: "new_issue" }],
    severity: "high",
  });
  // Every account starts with an "Account email" channel, so owner and member have one each
  await db.insert(notificationChannels).values({
    orgId: owner.org.id,
    type: "webhook",
    name: "Ops webhook",
    config: { url: "https://hooks.example.com/pulse", secret: "whsec_test" },
  });
});

afterAll(async () => {
  await deleteTestUsers(PREFIX);
  await app.close();
});

describe("first responder", () => {
  it("records the trigger and, with nobody on call, tells every member once", async () => {
    const incidentId = await newIncident();
    const first = await planIncidentNotifications(incidentId);
    const again = await planIncidentNotifications(incidentId); // a retried job

    // owner + member emails + the org webhook
    expect(first).toHaveLength(3);
    expect(again.sort()).toEqual(first.sort());

    const timeline = await timelineOf(incidentId);
    expect(timeline.map((step) => step.kind)).toEqual(["triggered", "notified"]);
    expect(timeline[0]?.data).toMatchObject({ ruleName: "Every new issue" });
    expect(timeline[1]?.data).toEqual({ responder: null, everyone: true, channels: 3 });
  });

  it("only wakes the on-call person (plus team channels)", async () => {
    vi.mocked(getFirstResponder).mockResolvedValueOnce({
      userId: member.user.id,
      source: "layer",
    });
    const incidentId = await newIncident();
    const deliveryIds = await planIncidentNotifications(incidentId);

    const planned = await db
      .select({ recipient: notificationLog.recipient })
      .from(notificationLog)
      .where(inArray(notificationLog.id, deliveryIds));
    expect(planned.map((row) => row.recipient).sort()).toEqual(
      [member.user.email, "hooks.example.com"].sort(),
    );

    const [incident] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
    expect(incident?.responderId).toBe(member.user.id);
    const notified = (await timelineOf(incidentId)).find((step) => step.kind === "notified");
    expect(notified?.data).toEqual({
      responder: { id: member.user.id, name: "Member", source: "layer" },
      everyone: false,
      channels: 2,
    });
  });

  it("falls back to everyone when the on-call person has no channel", async () => {
    const quiet = await createTestUser(email("quiet"), "Quiet");
    await as(owner, "POST", `/orgs/${owner.org.id}/members`, { email: quiet.user.email });
    await db.delete(notificationChannels).where(eq(notificationChannels.userId, quiet.user.id));

    vi.mocked(getFirstResponder).mockResolvedValueOnce({
      userId: quiet.user.id,
      source: "override",
    });
    const incidentId = await newIncident();
    expect(await planIncidentNotifications(incidentId)).toHaveLength(3);
    const notified = (await timelineOf(incidentId)).find((step) => step.kind === "notified");
    expect(notified?.data).toMatchObject({ everyone: true, channels: 3 });
  });

  it("ignores an on-call person who isn't in the org", async () => {
    vi.mocked(getFirstResponder).mockResolvedValueOnce({
      userId: outsider.user.id, // has an account email, but no business seeing this
      source: "layer",
    });
    const incidentId = await newIncident();
    const deliveryIds = await planIncidentNotifications(incidentId);
    const planned = await db
      .select({ recipient: notificationLog.recipient })
      .from(notificationLog)
      .where(inArray(notificationLog.id, deliveryIds));
    expect(planned.map((row) => row.recipient)).not.toContain(outsider.user.email);
  });
});

describe("acknowledge", () => {
  it("records who took it, and tells the second person who was first", async () => {
    const incidentId = await newIncident();

    const first = await as(member, "POST", `/incidents/${incidentId}/acknowledge`);
    expect(first.statusCode).toBe(200);
    expect(first.json().incident).toMatchObject({
      status: "acknowledged",
      acknowledgedBy: member.user.id,
    });

    const second = await as(owner, "POST", `/incidents/${incidentId}/acknowledge`);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({
      code: "ALREADY_ACKNOWLEDGED",
      message: "Member already acknowledged this incident",
      acknowledgedBy: { id: member.user.id, name: "Member" },
    });

    // The same person clicking again is fine
    expect((await as(member, "POST", `/incidents/${incidentId}/acknowledge`)).statusCode).toBe(200);

    const acks = (await timelineOf(incidentId)).filter((step) => step.kind === "acknowledged");
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({ actorId: member.user.id, data: { via: "dashboard" } });
  });

  it("lets exactly one of two simultaneous clicks win", async () => {
    const incidentId = await newIncident();
    const results = await Promise.all([
      as(owner, "POST", `/incidents/${incidentId}/acknowledge`),
      as(member, "POST", `/incidents/${incidentId}/acknowledge`),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });

  it("stops pending notifications for an acknowledged incident", async () => {
    const incidentId = await newIncident();
    await as(owner, "POST", `/incidents/${incidentId}/acknowledge`);
    expect(await planIncidentNotifications(incidentId)).toEqual([]);
  });
});

describe("resolve", () => {
  it("closes an acknowledged incident, and resolved is final", async () => {
    const incidentId = await newIncident();
    await as(member, "POST", `/incidents/${incidentId}/acknowledge`);

    const resolved = await as(member, "POST", `/incidents/${incidentId}/resolve`);
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().incident).toMatchObject({
      status: "resolved",
      resolvedBy: member.user.id,
    });

    const again = await as(owner, "POST", `/incidents/${incidentId}/resolve`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("INCIDENT_RESOLVED");

    const ack = await as(owner, "POST", `/incidents/${incidentId}/acknowledge`);
    expect(ack.statusCode).toBe(409);
    expect(ack.json().error.code).toBe("INCIDENT_RESOLVED");
  });

  it("can skip acknowledging, and can resolve the issue too", async () => {
    const incidentId = await newIncident();
    const res = await as(owner, "POST", `/incidents/${incidentId}/resolve`, {
      resolveIssue: true,
    });
    expect(res.statusCode).toBe(200);

    const issueId = res.json().incident.issueId;
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("resolved");
    const activity = await db
      .select({ action: issueActivity.action })
      .from(issueActivity)
      .where(eq(issueActivity.issueId, issueId));
    expect(activity.map((row) => row.action)).toEqual(
      expect.arrayContaining(["incident_created", "incident_resolved", "status_changed"]),
    );
  });

  it("rejects a bad body", async () => {
    const incidentId = await newIncident();
    const res = await as(owner, "POST", `/incidents/${incidentId}/resolve`, {
      resolveIssue: "yes",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("access", () => {
  it("hides incidents from outsiders and logged-out users", async () => {
    const incidentId = await newIncident();
    expect((await as(outsider, "GET", `/incidents/${incidentId}`)).statusCode).toBe(404);
    expect((await as(outsider, "POST", `/incidents/${incidentId}/acknowledge`)).statusCode).toBe(
      404,
    );
    expect((await as(null, "POST", `/incidents/${incidentId}/resolve`)).statusCode).toBe(401);
    expect((await as(owner, "GET", "/incidents/not-a-uuid")).statusCode).toBe(404);
  });
});

describe("incident detail and list", () => {
  it("tells the whole story in order", async () => {
    const incidentId = await newIncident();
    await planIncidentNotifications(incidentId);
    await as(member, "POST", `/incidents/${incidentId}/acknowledge`);
    await as(owner, "POST", `/incidents/${incidentId}/resolve`);

    const res = await as(owner, "GET", `/incidents/${incidentId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.incident).toMatchObject({
      status: "resolved",
      project: { name: "Shop" },
      rule: { name: "Every new issue" },
      acknowledgedBy: { id: member.user.id, name: "Member" },
      resolvedBy: { id: owner.user.id, name: "Owner" },
    });
    expect(body.timeline.map((step: { kind: string }) => step.kind)).toEqual([
      "triggered",
      "notified",
      "acknowledged",
      "resolved",
    ]);
    expect(body.timeline[2].actor).toEqual({ id: member.user.id, name: "Member" });
    expect(body.deliveries).toHaveLength(3);
  });

  it("lists a project's incidents with who handled them", async () => {
    const incidentId = await newIncident();
    await as(member, "POST", `/incidents/${incidentId}/acknowledge`);

    const res = await as(owner, "GET", `/projects/${projectId}/incidents?status=acknowledged`);
    expect(res.statusCode).toBe(200);
    const found = res.json().incidents.find((i: { id: string }) => i.id === incidentId);
    expect(found).toMatchObject({ acknowledgedBy: { name: "Member" }, resolvedBy: null });
    expect(res.json().incidents.every((i: { status: string }) => i.status === "acknowledged")).toBe(
      true,
    );
  });
});

describe("one-click links", () => {
  it("shows the incident and acknowledges as the person the link was sent to", async () => {
    const incidentId = await newIncident();
    const token = createAckToken(incidentId, member.user.id);

    // No cookies: the reader isn't logged in
    const view = await as(null, "GET", `/incidents/${incidentId}/link?token=${token}`);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      incident: { id: incidentId, status: "triggered" },
      project: { name: "Shop" },
      user: { id: member.user.id, name: "Member" },
      needsLogin: false,
    });

    const ack = await as(null, "POST", `/incidents/${incidentId}/link/acknowledge`, { token });
    expect(ack.statusCode).toBe(200);
    expect(ack.json().incident.acknowledgedBy).toBe(member.user.id);
    const step = (await timelineOf(incidentId)).find((s) => s.kind === "acknowledged");
    expect(step?.data).toEqual({ via: "link" });
  });

  it("rejects forged, expired and other incidents' links", async () => {
    const incidentId = await newIncident();
    const otherId = await newIncident();
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const good = createAckToken(incidentId, member.user.id);
    const [userPart, expires] = good.split(".");

    for (const token of [
      `${userPart}.${expires}.forged-signature`,
      `${owner.user.id}.${expires}.${good.split(".")[2]}`, // someone else's name on it
      createAckToken(incidentId, member.user.id, tenDaysAgo),
      createAckToken(otherId, member.user.id),
    ]) {
      const res = await as(null, "POST", `/incidents/${incidentId}/link/acknowledge`, { token });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("INVALID_LINK");
    }
    const [incident] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
    expect(incident?.status).toBe("triggered");
  });

  it("asks a team link's reader to log in first", async () => {
    const incidentId = await newIncident();
    const token = createAckToken(incidentId, null); // e.g. from a webhook

    const view = await as(null, "GET", `/incidents/${incidentId}/link?token=${token}`);
    expect(view.json()).toMatchObject({ user: null, needsLogin: true });
    const anonymous = await as(null, "POST", `/incidents/${incidentId}/link/acknowledge`, {
      token,
    });
    expect(anonymous.statusCode).toBe(401);

    const loggedIn = await as(owner, "POST", `/incidents/${incidentId}/link/acknowledge`, {
      token,
    });
    expect(loggedIn.statusCode).toBe(200);
    expect(loggedIn.json().incident.acknowledgedBy).toBe(owner.user.id);
  });

  it("stops working for someone who left the org", async () => {
    const leaver = await createTestUser(email("leaver"), "Leaver");
    await as(owner, "POST", `/orgs/${owner.org.id}/members`, { email: leaver.user.email });
    const incidentId = await newIncident();
    const token = createAckToken(incidentId, leaver.user.id);

    await db
      .delete(memberships)
      .where(and(eq(memberships.orgId, owner.org.id), eq(memberships.userId, leaver.user.id)));
    const res = await as(null, "POST", `/incidents/${incidentId}/link/acknowledge`, { token });
    expect(res.statusCode).toBe(403);
  });
});
