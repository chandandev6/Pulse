import { and, asc, eq, inArray } from "drizzle-orm";
import { db, type Tx } from "../db/client.js";
import {
  escalationLevels,
  escalationPolicies,
  escalationTargets,
  schedules,
  users,
} from "../db/schema.js";
import type { EscalationTarget } from "../incidents/timeline.js";
import { getOnCallForSchedule } from "../schedules/service.js";

export type PolicyTarget =
  | { type: "user"; id: string; name: string }
  | { type: "schedule"; id: string; name: string };

export type PolicyLevel = {
  id: string;
  position: number;
  timeoutMinutes: number;
  targets: PolicyTarget[];
};

export type Policy = typeof escalationPolicies.$inferSelect & { levels: PolicyLevel[] };

// Policies with their levels (in order) and each level's targets, with names
export async function loadPolicies(policyIds: string[]): Promise<Map<string, Policy>> {
  const result = new Map<string, Policy>();
  if (policyIds.length === 0) return result;

  const [policies, levels] = await Promise.all([
    db.select().from(escalationPolicies).where(inArray(escalationPolicies.id, policyIds)),
    db
      .select()
      .from(escalationLevels)
      .where(inArray(escalationLevels.policyId, policyIds))
      .orderBy(asc(escalationLevels.position)),
  ]);
  const targets = levels.length
    ? await db
        .select({
          levelId: escalationTargets.levelId,
          user: { id: users.id, name: users.name },
          schedule: { id: schedules.id, name: schedules.name },
        })
        .from(escalationTargets)
        .leftJoin(users, eq(users.id, escalationTargets.userId))
        .leftJoin(schedules, eq(schedules.id, escalationTargets.scheduleId))
        .where(
          inArray(
            escalationTargets.levelId,
            levels.map((level) => level.id),
          ),
        )
        .orderBy(asc(escalationTargets.id))
    : [];

  for (const policy of policies) result.set(policy.id, { ...policy, levels: [] });
  const byLevel = new Map<string, PolicyLevel>();
  for (const level of levels) {
    const entry = { ...level, targets: [] };
    byLevel.set(level.id, entry);
    result.get(level.policyId)?.levels.push(entry);
  }
  for (const { levelId, user, schedule } of targets) {
    const target: PolicyTarget | null = user
      ? { type: "user", ...user }
      : schedule
        ? { type: "schedule", ...schedule }
        : null;
    if (target) byLevel.get(levelId)?.targets.push(target);
  }
  return result;
}

export async function loadPolicy(policyId: string) {
  return (await loadPolicies([policyId])).get(policyId) ?? null;
}

// The people a level reaches right now: its users, plus whoever is on call
// on its schedules. Someone listed twice is only told once.
export async function resolveLevelTargets(
  level: PolicyLevel,
  at: Date,
): Promise<EscalationTarget[]> {
  const found = new Map<string, EscalationTarget>();
  for (const target of level.targets) {
    if (target.type === "user") {
      if (!found.has(target.id)) {
        found.set(target.id, { id: target.id, name: target.name, schedule: null });
      }
      continue;
    }
    const onCall = await getOnCallForSchedule(target.id, at);
    if (onCall && !found.has(onCall.userId)) {
      found.set(onCall.userId, {
        id: onCall.userId,
        name: "",
        schedule: { id: target.id, name: target.name },
      });
    }
  }

  // Names for the people we only know from schedules
  const unnamed = [...found.values()].filter((target) => !target.name).map((target) => target.id);
  if (unnamed.length > 0) {
    const rows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, unnamed));
    for (const row of rows) {
      const target = found.get(row.id);
      if (target) target.name = row.name;
    }
  }
  return [...found.values()];
}

// Someone left the org: they're no longer a target of its policies
export async function removeFromEscalationPolicies(tx: Tx, orgId: string, userId: string) {
  const orgLevels = tx
    .select({ id: escalationLevels.id })
    .from(escalationLevels)
    .innerJoin(escalationPolicies, eq(escalationPolicies.id, escalationLevels.policyId))
    .where(eq(escalationPolicies.orgId, orgId));
  await tx
    .delete(escalationTargets)
    .where(
      and(eq(escalationTargets.userId, userId), inArray(escalationTargets.levelId, orgLevels)),
    );
}
