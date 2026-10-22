import { and, desc, eq, ne } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import {
  alertRules,
  events,
  incidents,
  issueActivity,
  issues,
  type Severity,
} from "../db/schema.js";
import { addTimeline } from "../incidents/service.js";
import { redis } from "../redis.js";
import type { AlertCondition } from "./conditions.js";

type Rule = typeof alertRules.$inferSelect;

// What the worker knows about the issue right after grouping an event
export type IssueSnapshot = {
  id: string;
  projectId: string;
  title: string;
  severity: Severity;
  userCount: number;
  isNew: boolean; // this event created the issue
  isNewInEnvironment: boolean; // this is the issue's first event in this environment
  regressed: boolean; // this event reopened a resolved issue
};

export type EvaluationContext = {
  issue: IssueSnapshot;
  environment: string;
  eventId: string;
  now: number; // ms
};

// ---------- "N events in X minutes": a sliding window in Redis ----------
//
// One sorted set per issue (and per issue + environment). Each event is a member,
// scored by when it arrived. Counting the last X minutes = ZCOUNT from now-X to now.
// Old members are trimmed, and the key expires, so memory stays small.

export const FREQUENCY_PREFIX = "pulse-alerts:freq:";
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000; // the longest window a rule can ask for

const windowKey = (issueId: string, environment: string | null) =>
  `${FREQUENCY_PREFIX}${issueId}:${environment ?? "*"}`;

async function recordForFrequency({ issue, environment, eventId, now }: EvaluationContext) {
  const pipeline = redis.multi();
  for (const key of [windowKey(issue.id, null), windowKey(issue.id, environment)]) {
    // The member is the event id, so a retried job doesn't count the same event twice
    pipeline.zadd(key, now, eventId);
    pipeline.zremrangebyscore(key, 0, now - MAX_WINDOW_MS);
    pipeline.pexpire(key, MAX_WINDOW_MS);
  }
  await pipeline.exec();
}

async function eventsInLast(
  minutes: number,
  issueId: string,
  environment: string | null,
  now: number,
) {
  return redis.zcount(windowKey(issueId, environment), now - minutes * 60_000, "+inf");
}

// ---------- Conditions ----------

// "More than N" means strictly greater: "more than 100 events" fires on the 101st
async function conditionMet(condition: AlertCondition, rule: Rule, ctx: EvaluationContext) {
  const { issue } = ctx;
  switch (condition.type) {
    case "new_issue":
      // A rule for one environment cares when the issue first shows up *there*,
      // e.g. a bug seen in staging that now reaches production
      return rule.environment ? issue.isNewInEnvironment : issue.isNew;
    case "regression":
      return issue.regressed;
    case "severity_critical":
      return issue.severity === "critical";
    case "user_count":
      return issue.userCount > condition.count;
    case "event_frequency":
      return (
        (await eventsInLast(condition.minutes, issue.id, rule.environment, ctx.now)) >
        condition.count
      );
  }
}

export async function ruleMatches(rule: Rule, ctx: EvaluationContext): Promise<boolean> {
  if (rule.environment && rule.environment !== ctx.environment) return false;
  if (rule.conditions.length === 0) return false;

  for (const condition of rule.conditions) {
    const met = await conditionMet(condition, rule, ctx);
    if (rule.match === "any" && met) return true; // one is enough
    if (rule.match === "all" && !met) return false; // one miss is enough
  }
  return rule.match === "all";
}

// ---------- Firing ----------

// Opens an incident unless one is already open for this issue + rule,
// or the last one closed less than cooldownMinutes ago.
async function fire(tx: Tx, rule: Rule, ctx: EvaluationContext) {
  const { issue, now } = ctx;

  const [last] = await tx
    .select({ status: incidents.status, resolvedAt: incidents.resolvedAt })
    .from(incidents)
    .where(and(eq(incidents.ruleId, rule.id), eq(incidents.issueId, issue.id)))
    .orderBy(desc(incidents.triggeredAt))
    .limit(1);
  if (last && last.status !== "resolved") return null; // already open
  if (last?.resolvedAt && now - last.resolvedAt.getTime() < rule.cooldownMinutes * 60_000) {
    return null; // cooling down
  }

  // The partial unique index is the real guard: if another worker opened one
  // a moment ago, this insert does nothing
  const [incident] = await tx
    .insert(incidents)
    .values({
      projectId: issue.projectId,
      issueId: issue.id,
      ruleId: rule.id,
      title: issue.title,
      severity: rule.severity,
      triggeredAt: new Date(now),
    })
    .onConflictDoNothing()
    .returning();
  if (!incident) return null;

  await tx
    .update(alertRules)
    .set({ lastTriggeredAt: new Date(now) })
    .where(eq(alertRules.id, rule.id));
  await tx.insert(issueActivity).values({
    issueId: issue.id,
    action: "incident_created",
    data: { incidentId: incident.id, ruleId: rule.id, ruleName: rule.name },
  });
  await addTimeline(tx, incident.id, "triggered", { ruleId: rule.id, ruleName: rule.name });
  return incident;
}

// Runs inside the worker's transaction, right after an event was grouped.
// If anything fails, the whole transaction (event included) is retried by BullMQ.
export async function evaluateAlertRules(
  tx: Tx,
  ctx: Omit<EvaluationContext, "issue"> & {
    issue: Omit<IssueSnapshot, "userCount" | "severity" | "title" | "isNewInEnvironment">;
  },
) {
  const rules = await tx
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.projectId, ctx.issue.projectId), eq(alertRules.enabled, true)));
  if (rules.length === 0) return [];

  // The issue's numbers *after* this event (we hold its row lock, so they're current)
  const [current] = await tx
    .select({ title: issues.title, severity: issues.severity, userCount: issues.userCount })
    .from(issues)
    .where(eq(issues.id, ctx.issue.id));
  if (!current) return [];

  // A brand-new issue is new everywhere. Otherwise it's new in this environment
  // when no *other* event of the issue was seen here. Only asked when a
  // "new issue" rule is filtered to this environment.
  // (We hold the issue's row lock, so two first events can't both see "none".)
  const needsEnvironmentCheck = rules.some(
    (rule) =>
      rule.environment === ctx.environment &&
      rule.conditions.some((condition) => condition.type === "new_issue"),
  );
  let isNewInEnvironment = ctx.issue.isNew;
  if (!isNewInEnvironment && needsEnvironmentCheck) {
    const [earlier] = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.issueId, ctx.issue.id),
          eq(events.environment, ctx.environment),
          ne(events.eventId, ctx.eventId),
        ),
      )
      .limit(1);
    isNewInEnvironment = !earlier;
  }

  const full: EvaluationContext = {
    ...ctx,
    issue: { ...ctx.issue, ...current, isNewInEnvironment },
  };

  const needsWindow = rules.some(
    (rule) =>
      (!rule.environment || rule.environment === ctx.environment) &&
      rule.conditions.some((condition) => condition.type === "event_frequency"),
  );
  if (needsWindow) await recordForFrequency(full);

  const opened = [];
  for (const rule of rules) {
    if (await ruleMatches(rule, full)) {
      const incident = await fire(tx, rule, full);
      if (incident) opened.push(incident);
    }
  }
  return opened;
}
