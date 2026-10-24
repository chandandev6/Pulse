import { and, count, desc, eq, exists, gte, or, type SQL, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, changedFields } from "../audit/log.js";
import { requireAuth } from "../auth/require-auth.js";
import { db } from "../db/client.js";
import {
  alertRules,
  escalationPolicies,
  events,
  incidents,
  issues,
  SEVERITIES,
} from "../db/schema.js";
import { AppError } from "../errors.js";
import { requireProjectRole } from "../orgs/access.js";
import { parse } from "../validate.js";
import { type AlertCondition, ConditionSchema, MATCH_MODES } from "./conditions.js";

type ProjectParams = { projectId: string };
type RuleParams = { projectId: string; ruleId: string };

const RuleFields = {
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  environment: z.string().trim().min(1).max(200).nullable(), // null = every environment
  match: z.enum(MATCH_MODES),
  conditions: z.array(ConditionSchema).min(1).max(10),
  severity: z.enum(SEVERITIES),
  escalationPolicyId: z.uuid().nullable(), // null = the project's on-call person (F13)
  cooldownMinutes: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60),
};

const CreateRuleSchema = z.object({
  ...RuleFields,
  enabled: RuleFields.enabled.default(true),
  environment: RuleFields.environment.default(null),
  match: RuleFields.match.default("any"),
  escalationPolicyId: RuleFields.escalationPolicyId.default(null),
  cooldownMinutes: RuleFields.cooldownMinutes.default(30),
});

const UpdateRuleSchema = z
  .object(RuleFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, "Send at least one field to update");

const PreviewSchema = z.object({
  environment: RuleFields.environment.default(null),
  match: RuleFields.match.default("any"),
  conditions: RuleFields.conditions,
});

const PREVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

// A rule can only use one of its own org's policies
async function assertPolicyInOrg(orgId: string, policyId: string | null | undefined) {
  if (!policyId) return;
  const [policy] = await db
    .select({ id: escalationPolicies.id })
    .from(escalationPolicies)
    .where(and(eq(escalationPolicies.id, policyId), eq(escalationPolicies.orgId, orgId)));
  if (!policy) {
    throw new AppError(400, "INVALID_POLICY", "Pick an escalation policy of this organization");
  }
}

const ruleNotFound = () => new AppError(404, "RULE_NOT_FOUND", "Alert rule not found");

async function findRule(projectId: string, ruleId: string) {
  if (!z.uuid().safeParse(ruleId).success) throw ruleNotFound();
  const [rule] = await db
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.id, ruleId), eq(alertRules.projectId, projectId)));
  if (!rule) throw ruleNotFound();
  return rule;
}

// The same conditions as the worker uses, but as SQL over issues already stored,
// for the "Test rule" button: "which recent issues would this rule have caught?"
function conditionSql(condition: AlertCondition, environment: string | null, now: number): SQL {
  switch (condition.type) {
    case "new_issue":
      return gte(issues.firstSeen, new Date(now - PREVIEW_WINDOW_MS));
    case "regression":
      return eq(issues.isRegression, true);
    case "severity_critical":
      return eq(issues.severity, "critical");
    case "user_count":
      return sql`${issues.userCount} > ${condition.count}`;
    case "event_frequency": {
      const since = new Date(now - condition.minutes * 60_000);
      return sql`(
        select count(*) from ${events}
        where ${events.issueId} = ${issues.id}
          and ${events.receivedAt} >= ${since}
          ${environment ? sql`and ${events.environment} = ${environment}` : sql``}
      ) > ${condition.count}`;
    }
  }
}

function previewWhere(projectId: string, rule: z.infer<typeof PreviewSchema>, now: number) {
  const parts = rule.conditions.map((c) => conditionSql(c, rule.environment, now));
  const combine = rule.match === "all" ? and : or;
  return and(
    eq(issues.projectId, projectId),
    gte(issues.lastSeen, new Date(now - PREVIEW_WINDOW_MS)), // only recent issues
    rule.environment
      ? exists(
          db
            .select({ one: sql`1` })
            .from(events)
            .where(and(eq(events.issueId, issues.id), eq(events.environment, rule.environment))),
        )
      : undefined,
    combine(...parts),
  );
}

export async function alertRoutes(app: FastifyInstance) {
  // Everyone in the org can see the rules; only admins can change them
  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/alert-rules",
    { preHandler: [requireAuth, requireProjectRole("member")] },
    async (request) => {
      const openIncidents = db
        .select({ ruleId: incidents.ruleId, count: count().as("open_incidents") })
        .from(incidents)
        .where(sql`${incidents.status} <> 'resolved'`)
        .groupBy(incidents.ruleId)
        .as("open_incidents");

      const rows = await db
        .select({
          rule: alertRules,
          openIncidents: sql`coalesce(${openIncidents.count}, 0)`.mapWith(Number),
        })
        .from(alertRules)
        .leftJoin(openIncidents, eq(openIncidents.ruleId, alertRules.id))
        .where(eq(alertRules.projectId, request.project.id))
        .orderBy(alertRules.createdAt);

      return { rules: rows.map(({ rule, openIncidents }) => ({ ...rule, openIncidents })) };
    },
  );

  app.post<{ Params: ProjectParams }>(
    "/projects/:projectId/alert-rules",
    { preHandler: [requireAuth, requireProjectRole("admin")] },
    async (request, reply) => {
      const body = parse(CreateRuleSchema, request.body);
      await assertPolicyInOrg(request.project.orgId, body.escalationPolicyId);
      const [rule] = await db
        .insert(alertRules)
        .values({ ...body, projectId: request.project.id, createdBy: request.user.id })
        .returning();
      if (!rule) throw new Error("rule not created");
      await audit(request, {
        orgId: request.project.orgId,
        action: "alert_rule.created",
        targetType: "alert_rule",
        targetId: rule.id,
        data: { name: rule.name, projectId: request.project.id },
      });
      return reply.code(201).send({ rule });
    },
  );

  // "Test rule": try a rule (saved or not) against the last 24 hours of issues
  app.post<{ Params: ProjectParams }>(
    "/projects/:projectId/alert-rules/preview",
    { preHandler: [requireAuth, requireProjectRole("member")] },
    async (request) => {
      const rule = parse(PreviewSchema, request.body);
      const where = previewWhere(request.project.id, rule, Date.now());

      const [matches, [total]] = await Promise.all([
        db.select().from(issues).where(where).orderBy(desc(issues.lastSeen)).limit(20),
        db.select({ count: count() }).from(issues).where(where),
      ]);
      return { matches, total: total?.count ?? 0 };
    },
  );

  app.get<{ Params: RuleParams }>(
    "/projects/:projectId/alert-rules/:ruleId",
    { preHandler: [requireAuth, requireProjectRole("member")] },
    async (request) => ({ rule: await findRule(request.project.id, request.params.ruleId) }),
  );

  app.patch<{ Params: RuleParams }>(
    "/projects/:projectId/alert-rules/:ruleId",
    { preHandler: [requireAuth, requireProjectRole("admin")] },
    async (request) => {
      const changes = parse(UpdateRuleSchema, request.body);
      await assertPolicyInOrg(request.project.orgId, changes.escalationPolicyId);
      const existing = await findRule(request.project.id, request.params.ruleId);
      const [rule] = await db
        .update(alertRules)
        .set({ ...changes, updatedAt: new Date() })
        .where(eq(alertRules.id, existing.id))
        .returning();
      await audit(request, {
        orgId: request.project.orgId,
        action: "alert_rule.updated",
        targetType: "alert_rule",
        targetId: existing.id,
        data: { name: existing.name, ...changedFields(changes) },
      });
      return { rule };
    },
  );

  // Incidents it opened stay (with rule_id = null): history isn't deleted with the rule
  app.delete<{ Params: RuleParams }>(
    "/projects/:projectId/alert-rules/:ruleId",
    { preHandler: [requireAuth, requireProjectRole("admin")] },
    async (request, reply) => {
      const rule = await findRule(request.project.id, request.params.ruleId);
      await db.delete(alertRules).where(eq(alertRules.id, rule.id));
      await audit(request, {
        orgId: request.project.orgId,
        action: "alert_rule.deleted",
        targetType: "alert_rule",
        targetId: rule.id,
        data: { name: rule.name },
      });
      return reply.code(204).send();
    },
  );
}
