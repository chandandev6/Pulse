import { type EventInput, EventSchema } from "@pulse/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AlertCondition } from "../src/alerts/conditions.js";
import { buildApp } from "../src/app.js";
import { db } from "../src/db/client.js";
import { alertRules, incidents, issueActivity, issues, projects } from "../src/db/schema.js";
import { saveEvent } from "../src/events/store.js";
import { addMember, createTestUser, deleteTestUsers } from "./helpers.js";

const app = buildApp();

const PREFIX = "alerttest-";
const run = Date.now();
const email = (name: string) => `${PREFIX}${name}-${run}@example.com`;

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
let owner: TestUser;
let member: TestUser;
let outsider: TestUser;

function as(
  user: TestUser,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: object,
) {
  return app.inject({ method, url, cookies: user.cookies, payload: body });
}

async function newProject() {
  const [project] = await db
    .insert(projects)
    .values({ orgId: owner.org.id, name: "Alerts", slug: crypto.randomUUID(), platform: "node" })
    .returning();
  if (!project) throw new Error("project not created");
  return project.id;
}

async function addRule(
  projectId: string,
  conditions: AlertCondition[],
  extra: Partial<typeof alertRules.$inferInsert> = {},
) {
  const [rule] = await db
    .insert(alertRules)
    .values({ projectId, name: "Test rule", conditions, severity: "high", ...extra })
    .returning();
  if (!rule) throw new Error("rule not created");
  return rule;
}

async function send(projectId: string, input: EventInput = {}) {
  const saved = await saveEvent({
    projectId,
    receivedAt: new Date().toISOString(),
    event: EventSchema.parse({ exception: { type: "TypeError", value: "boom" }, ...input }),
  });
  if (!saved) throw new Error("event not saved");
  return saved;
}

const incidentsOf = (projectId: string) =>
  db.select().from(incidents).where(eq(incidents.projectId, projectId));

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

describe("conditions", () => {
  it("new issue: fires on the first event only, and links the incident to issue and rule", async () => {
    const projectId = await newProject();
    const rule = await addRule(projectId, [{ type: "new_issue" }], { severity: "critical" });

    const first = await send(projectId);
    expect(first.incidentIds).toHaveLength(1);
    await send(projectId); // same issue again

    const found = await incidentsOf(projectId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      issueId: first.issueId,
      ruleId: rule.id,
      severity: "critical", // from the rule, not the issue
      status: "triggered",
      title: "TypeError: boom",
    });

    const activity = await db
      .select()
      .from(issueActivity)
      .where(
        and(eq(issueActivity.issueId, first.issueId), eq(issueActivity.action, "incident_created")),
      );
    expect(activity).toHaveLength(1);
  });

  it("regression: fires when a resolved issue comes back", async () => {
    const projectId = await newProject();
    await addRule(projectId, [{ type: "regression" }]);
    const { issueId } = await send(projectId);
    expect(await incidentsOf(projectId)).toHaveLength(0);

    await db.update(issues).set({ status: "resolved" }).where(eq(issues.id, issueId));
    const back = await send(projectId);
    expect(back.incidentIds).toHaveLength(1);
  });

  it("severity critical: fires for fatal errors, not for normal ones", async () => {
    const projectId = await newProject();
    await addRule(projectId, [{ type: "severity_critical" }]);

    await send(projectId, { exception: { type: "RangeError", value: "meh" }, level: "error" });
    expect(await incidentsOf(projectId)).toHaveLength(0);
    await send(projectId, { exception: { type: "OutOfMemory", value: "dead" }, level: "fatal" });
    expect(await incidentsOf(projectId)).toHaveLength(1);
  });

  it("user count: fires when MORE than N users are affected", async () => {
    const projectId = await newProject();
    await addRule(projectId, [{ type: "user_count", count: 2 }]);

    expect((await send(projectId, { user: { id: "1" } })).incidentIds).toHaveLength(0);
    expect((await send(projectId, { user: { id: "2" } })).incidentIds).toHaveLength(0);
    expect((await send(projectId, { user: { id: "2" } })).incidentIds).toHaveLength(0); // same user
    expect((await send(projectId, { user: { id: "3" } })).incidentIds).toHaveLength(1);
  });

  it("event frequency: fires when MORE than N events arrive within X minutes", async () => {
    const projectId = await newProject();
    await addRule(projectId, [{ type: "event_frequency", count: 3, minutes: 10 }]);

    for (let i = 0; i < 3; i++) expect((await send(projectId)).incidentIds).toHaveLength(0);
    expect((await send(projectId)).incidentIds).toHaveLength(1); // the 4th
  });

  it("match all needs every condition; match any needs one", async () => {
    const projectId = await newProject();
    await addRule(projectId, [{ type: "new_issue" }, { type: "severity_critical" }], {
      match: "all",
      name: "new AND critical",
    });

    await send(projectId, { exception: { type: "A", value: "x" }, level: "error" }); // new, not critical
    expect(await incidentsOf(projectId)).toHaveLength(0);
    await send(projectId, { exception: { type: "B", value: "x" }, level: "fatal" }); // new AND critical
    expect(await incidentsOf(projectId)).toHaveLength(1);
  });

  it("disabled rules never fire", async () => {
    const projectId = await newProject();
    await addRule(projectId, [{ type: "new_issue" }], { enabled: false });
    await send(projectId);
    expect(await incidentsOf(projectId)).toHaveLength(0);
  });
});

describe("environment filter", () => {
  it("only looks at events from the rule's environment", async () => {
    const projectId = await newProject();
    await addRule(projectId, [{ type: "event_frequency", count: 1, minutes: 5 }], {
      environment: "production",
    });

    // Lots of staging noise doesn't count...
    for (let i = 0; i < 3; i++) await send(projectId, { environment: "staging" });
    expect(await incidentsOf(projectId)).toHaveLength(0);

    // ...but 2 production events do (more than 1)
    await send(projectId, { environment: "production" });
    expect((await send(projectId, { environment: "production" })).incidentIds).toHaveLength(1);
  });

  it("new issue: fires when an issue first reaches the rule's environment", async () => {
    const projectId = await newProject();
    await addRule(projectId, [{ type: "new_issue" }], { environment: "production" });

    // Seen in staging first: the issue is created, but not in production yet
    await send(projectId, { environment: "staging" });
    expect(await incidentsOf(projectId)).toHaveLength(0);

    // Its first production event is "new" for this rule; the second is not
    expect((await send(projectId, { environment: "production" })).incidentIds).toHaveLength(1);
    expect((await send(projectId, { environment: "production" })).incidentIds).toHaveLength(0);
  });
});

describe("de-duplication and cooldown", () => {
  it("opens exactly one incident even when many workers race", async () => {
    const projectId = await newProject();
    await addRule(projectId, [{ type: "severity_critical" }]);
    await send(projectId, { level: "fatal" }); // creates the issue

    // Make it fire on every one of 20 parallel events... after closing the first incident
    await db
      .update(incidents)
      .set({ status: "resolved", resolvedAt: new Date(0) })
      .where(eq(incidents.projectId, projectId));
    await Promise.all(Array.from({ length: 20 }, () => send(projectId, { level: "fatal" })));

    const open = (await incidentsOf(projectId)).filter((i) => i.status !== "resolved");
    expect(open).toHaveLength(1);
  });

  it("waits for the cooldown after an incident is resolved", async () => {
    const projectId = await newProject();
    const rule = await addRule(projectId, [{ type: "severity_critical" }], { cooldownMinutes: 30 });
    await send(projectId, { level: "fatal" });

    // Resolved just now: still cooling down, the next event doesn't reopen
    await db
      .update(incidents)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(incidents.ruleId, rule.id));
    expect((await send(projectId, { level: "fatal" })).incidentIds).toHaveLength(0);

    // Resolved 31 minutes ago: allowed again
    await db
      .update(incidents)
      .set({ resolvedAt: new Date(Date.now() - 31 * 60_000) })
      .where(eq(incidents.ruleId, rule.id));
    expect((await send(projectId, { level: "fatal" })).incidentIds).toHaveLength(1);
  });
});

describe("alert rule API", () => {
  it("lets admins create, update and delete rules; members only read", async () => {
    const projectId = await newProject();
    const url = `/projects/${projectId}/alert-rules`;
    const body = { name: "New errors", conditions: [{ type: "new_issue" }], severity: "high" };

    expect((await as(member, "POST", url, body)).statusCode).toBe(403);

    const created = await as(owner, "POST", url, body);
    expect(created.statusCode).toBe(201);
    const rule = created.json().rule;
    expect(rule).toMatchObject({
      enabled: true,
      match: "any",
      environment: null,
      cooldownMinutes: 30,
    });

    const list = await as(member, "GET", url);
    expect(list.json().rules).toEqual([expect.objectContaining({ id: rule.id, openIncidents: 0 })]);

    expect((await as(member, "PATCH", `${url}/${rule.id}`, { enabled: false })).statusCode).toBe(
      403,
    );
    const updated = await as(owner, "PATCH", `${url}/${rule.id}`, {
      enabled: false,
      conditions: [{ type: "event_frequency", count: 100, minutes: 60 }],
    });
    expect(updated.json().rule).toMatchObject({
      enabled: false,
      conditions: [{ type: "event_frequency" }],
    });

    expect((await as(owner, "DELETE", `${url}/${rule.id}`)).statusCode).toBe(204);
    expect((await as(owner, "GET", `${url}/${rule.id}`)).statusCode).toBe(404);
  });

  it("validates conditions", async () => {
    const projectId = await newProject();
    const url = `/projects/${projectId}/alert-rules`;
    const bad = [
      { name: "x", severity: "high", conditions: [] },
      { name: "x", severity: "high", conditions: [{ type: "solar_flare" }] },
      {
        name: "x",
        severity: "high",
        conditions: [{ type: "event_frequency", count: 0, minutes: 5 }],
      },
      {
        name: "x",
        severity: "high",
        conditions: [{ type: "event_frequency", count: 5, minutes: 5000 }],
      },
      { name: "x", severity: "urgent", conditions: [{ type: "new_issue" }] },
    ];
    for (const body of bad) expect((await as(owner, "POST", url, body)).statusCode).toBe(400);
  });

  it("keeps incidents when their rule is deleted", async () => {
    const projectId = await newProject();
    const rule = await addRule(projectId, [{ type: "new_issue" }]);
    await send(projectId);
    await as(owner, "DELETE", `/projects/${projectId}/alert-rules/${rule.id}`);

    const [kept] = await incidentsOf(projectId);
    expect(kept?.ruleId).toBeNull();
  });

  it("hides rules and incidents from other orgs", async () => {
    const projectId = await newProject();
    const rule = await addRule(projectId, [{ type: "new_issue" }]);
    for (const url of [`alert-rules`, `alert-rules/${rule.id}`, `incidents`]) {
      expect((await as(outsider, "GET", `/projects/${projectId}/${url}`)).statusCode).toBe(404);
    }
  });

  it("lists incidents with their rule, newest first", async () => {
    const projectId = await newProject();
    const rule = await addRule(projectId, [{ type: "new_issue" }], { name: "Every new error" });
    await send(projectId, { exception: { type: "A", value: "x" } });
    await send(projectId, { exception: { type: "B", value: "x" } });

    const res = await as(member, "GET", `/projects/${projectId}/incidents?ruleId=${rule.id}`);
    expect(res.json().incidents.map((i: { title: string }) => i.title)).toEqual(["B: x", "A: x"]);
    expect(res.json().incidents[0].rule).toEqual({ id: rule.id, name: "Every new error" });

    const list = await as(member, "GET", `/projects/${projectId}/alert-rules`);
    expect(list.json().rules[0].openIncidents).toBe(2);
  });
});

describe("rule preview (Test button)", () => {
  it("shows which recent issues a rule would catch, without saving anything", async () => {
    const projectId = await newProject();
    await send(projectId, { exception: { type: "Calm", value: "x" }, user: { id: "1" } });
    for (const id of ["1", "2", "3"]) {
      await send(projectId, { exception: { type: "Loud", value: "x" }, user: { id } });
    }
    await send(projectId, {
      exception: { type: "Staging", value: "x" },
      environment: "staging",
      level: "fatal",
    });

    const preview = (body: object) =>
      as(member, "POST", `/projects/${projectId}/alert-rules/preview`, body);

    const many = await preview({ conditions: [{ type: "user_count", count: 2 }] });
    expect(many.json().total).toBe(1);
    expect(many.json().matches[0].type).toBe("Loud");

    const busy = await preview({
      conditions: [{ type: "event_frequency", count: 2, minutes: 10 }],
    });
    expect(busy.json().matches.map((i: { type: string }) => i.type)).toEqual(["Loud"]);

    const critical = await preview({
      conditions: [{ type: "severity_critical" }],
      environment: "production",
    });
    expect(critical.json().total).toBe(0); // the critical one only happened in staging

    const allNew = await preview({ conditions: [{ type: "new_issue" }] });
    expect(allNew.json().total).toBe(3);
    expect(await incidentsOf(projectId)).toHaveLength(0);
  });
});
