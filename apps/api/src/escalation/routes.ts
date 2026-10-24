import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, changedFields } from "../audit/log.js";
import { requireAuth } from "../auth/require-auth.js";
import { db, type Tx } from "../db/client.js";
import {
  alertRules,
  escalationLevels,
  escalationPolicies,
  escalationTargets,
  memberships,
  projects,
  type Role,
  schedules,
} from "../db/schema.js";
import { AppError } from "../errors.js";
import { forbidden, hasRole, requireOrgRole } from "../orgs/access.js";
import { parse } from "../validate.js";
import { loadPolicies, loadPolicy } from "./service.js";

type OrgParams = { orgId: string };
type PolicyParams = { policyId: string };
type PolicyRow = typeof escalationPolicies.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    // Set by requirePolicyRole
    policy: PolicyRow;
  }
}

const TargetSchema = z.object({ type: z.enum(["user", "schedule"]), id: z.uuid() });

const LevelSchema = z.object({
  timeoutMinutes: z
    .int()
    .min(1)
    .max(24 * 60), // up to a day per level
  targets: z
    .array(TargetSchema)
    .min(1, "Each level needs at least one person or schedule")
    .max(10)
    .refine(
      (targets) => new Set(targets.map((t) => `${t.type}:${t.id}`)).size === targets.length,
      "Each person or schedule can only be listed once per level",
    ),
});
type LevelInput = z.infer<typeof LevelSchema>;

const PolicyFields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable(),
  repeatCount: z.int().min(0).max(9), // extra passes through every level
  levels: z.array(LevelSchema).min(1).max(10), // in order: level 1 first
};
const CreatePolicySchema = z.object({
  ...PolicyFields,
  description: PolicyFields.description.default(null),
  repeatCount: PolicyFields.repeatCount.default(0),
});
const UpdatePolicySchema = z
  .object(PolicyFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, "Send at least one field to update");

const isId = (value: string) => z.uuid().safeParse(value).success;
const policyNotFound = () => new AppError(404, "POLICY_NOT_FOUND", "Escalation policy not found");

// The same idea as requireScheduleRole: policy → org → your membership
function requirePolicyRole(minRole: Role) {
  return async (request: FastifyRequest) => {
    const { policyId } = request.params as PolicyParams;
    const [row] = isId(policyId)
      ? await db
          .select({ policy: escalationPolicies, role: memberships.role })
          .from(escalationPolicies)
          .innerJoin(
            memberships,
            and(
              eq(memberships.orgId, escalationPolicies.orgId),
              eq(memberships.userId, request.user.id),
            ),
          )
          .where(eq(escalationPolicies.id, policyId))
      : [];

    if (!row) throw policyNotFound();
    if (!hasRole(row.role, minRole)) throw forbidden(minRole);
    request.membership = { orgId: row.policy.orgId, role: row.role };
    request.policy = row.policy;
  };
}

// Every person must be in the org, and every schedule must be the org's
async function assertTargetsInOrg(orgId: string, levels: LevelInput[]) {
  const targets = levels.flatMap((level) => level.targets);
  const userIds = [...new Set(targets.filter((t) => t.type === "user").map((t) => t.id))];
  const scheduleIds = [...new Set(targets.filter((t) => t.type === "schedule").map((t) => t.id))];

  const [[members], [orgSchedules]] = await Promise.all([
    userIds.length
      ? db
          .select({ count: count() })
          .from(memberships)
          .where(and(eq(memberships.orgId, orgId), inArray(memberships.userId, userIds)))
      : [{ count: 0 }],
    scheduleIds.length
      ? db
          .select({ count: count() })
          .from(schedules)
          .where(and(eq(schedules.orgId, orgId), inArray(schedules.id, scheduleIds)))
      : [{ count: 0 }],
  ]);
  if ((members?.count ?? 0) !== userIds.length) {
    throw new AppError(
      400,
      "NOT_A_MEMBER",
      "Everyone in a policy must be a member of this organization",
    );
  }
  if ((orgSchedules?.count ?? 0) !== scheduleIds.length) {
    throw new AppError(400, "INVALID_SCHEDULE", "Use only this organization's schedules");
  }
}

// Levels are saved as a whole list: the order in the list is the order of escalation.
// (Reordering in the UI = sending the list in its new order.)
async function replaceLevels(tx: Tx, policyId: string, levels: LevelInput[]) {
  await tx.delete(escalationLevels).where(eq(escalationLevels.policyId, policyId));
  const saved = await tx
    .insert(escalationLevels)
    .values(
      levels.map((level, position) => ({
        policyId,
        position,
        timeoutMinutes: level.timeoutMinutes,
      })),
    )
    .returning({ id: escalationLevels.id, position: escalationLevels.position });
  saved.sort((a, b) => a.position - b.position);

  await tx.insert(escalationTargets).values(
    levels.flatMap((level, position) =>
      level.targets.map((target) => ({
        levelId: saved[position]?.id ?? "",
        userId: target.type === "user" ? target.id : null,
        scheduleId: target.type === "schedule" ? target.id : null,
      })),
    ),
  );
}

export async function escalationRoutes(app: FastifyInstance) {
  app.get<{ Params: OrgParams }>(
    "/orgs/:orgId/escalation-policies",
    { preHandler: [requireAuth, requireOrgRole("member")] },
    async (request) => {
      const rows = await db
        .select({ id: escalationPolicies.id })
        .from(escalationPolicies)
        .where(eq(escalationPolicies.orgId, request.membership.orgId))
        .orderBy(asc(escalationPolicies.name));
      const policies = await loadPolicies(rows.map((row) => row.id));

      // How many alert rules use each one (deleting a used policy is worth a warning)
      const usage = await db
        .select({ policyId: alertRules.escalationPolicyId, count: count() })
        .from(alertRules)
        .where(
          inArray(
            alertRules.escalationPolicyId,
            rows.map((row) => row.id),
          ),
        )
        .groupBy(alertRules.escalationPolicyId);
      const rulesById = new Map(usage.map((row) => [row.policyId, row.count]));

      return {
        policies: rows.flatMap((row) => {
          const policy = policies.get(row.id);
          return policy ? [{ ...policy, ruleCount: rulesById.get(row.id) ?? 0 }] : [];
        }),
      };
    },
  );

  app.post<{ Params: OrgParams }>(
    "/orgs/:orgId/escalation-policies",
    { preHandler: [requireAuth, requireOrgRole("admin")] },
    async (request, reply) => {
      const { levels, ...fields } = parse(CreatePolicySchema, request.body);
      const orgId = request.membership.orgId;
      await assertTargetsInOrg(orgId, levels);

      const policyId = await db.transaction(async (tx) => {
        const [policy] = await tx
          .insert(escalationPolicies)
          .values({ ...fields, orgId })
          .returning({ id: escalationPolicies.id });
        if (!policy) throw new Error("policy not created");
        await replaceLevels(tx, policy.id, levels);
        await audit(
          request,
          {
            orgId,
            action: "escalation_policy.created",
            targetType: "escalation_policy",
            targetId: policy.id,
            data: { name: fields.name },
          },
          tx,
        );
        return policy.id;
      });
      return reply.code(201).send({ policy: await loadPolicy(policyId) });
    },
  );

  // The policy, plus the alert rules that use it
  app.get<{ Params: PolicyParams }>(
    "/escalation-policies/:policyId",
    { preHandler: [requireAuth, requirePolicyRole("member")] },
    async (request) => {
      const [policy, rules] = await Promise.all([
        loadPolicy(request.policy.id),
        db
          .select({
            id: alertRules.id,
            name: alertRules.name,
            project: { id: projects.id, name: projects.name },
          })
          .from(alertRules)
          .innerJoin(projects, eq(projects.id, alertRules.projectId))
          .where(eq(alertRules.escalationPolicyId, request.policy.id))
          .orderBy(asc(projects.name), asc(alertRules.name)),
      ]);
      return { policy, rules };
    },
  );

  // Changes apply to incidents already escalating too, from their next step on
  app.patch<{ Params: PolicyParams }>(
    "/escalation-policies/:policyId",
    { preHandler: [requireAuth, requirePolicyRole("admin")] },
    async (request) => {
      const { levels, ...fields } = parse(UpdatePolicySchema, request.body);
      if (levels) await assertTargetsInOrg(request.policy.orgId, levels);

      await db.transaction(async (tx) => {
        await tx
          .update(escalationPolicies)
          .set({ ...fields, updatedAt: new Date() })
          .where(eq(escalationPolicies.id, request.policy.id));
        if (levels) await replaceLevels(tx, request.policy.id, levels);
        await audit(
          request,
          {
            orgId: request.policy.orgId,
            action: "escalation_policy.updated",
            targetType: "escalation_policy",
            targetId: request.policy.id,
            data: {
              name: request.policy.name,
              ...changedFields({ ...fields, ...(levels && { levels }) }),
            },
          },
          tx,
        );
      });
      return { policy: await loadPolicy(request.policy.id) };
    },
  );

  // Rules using it fall back to the project's on-call person; open incidents stop escalating
  app.delete<{ Params: PolicyParams }>(
    "/escalation-policies/:policyId",
    { preHandler: [requireAuth, requirePolicyRole("admin")] },
    async (request, reply) => {
      const { id, orgId, name } = request.policy;
      await db.delete(escalationPolicies).where(eq(escalationPolicies.id, id));
      await audit(request, {
        orgId,
        action: "escalation_policy.deleted",
        targetType: "escalation_policy",
        targetId: id,
        data: { name },
      });
      return reply.code(204).send();
    },
  );
}
