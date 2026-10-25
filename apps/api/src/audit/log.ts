import type { FastifyRequest } from "fastify";
import { db, type Tx } from "../db/client.js";
import { auditLog } from "../db/schema.js";

// Every action the audit log knows. A fixed list keeps names consistent,
// so "show me every key change" is a simple filter.
export const AUDIT_ACTIONS = [
  "org.updated",
  "member.added",
  "member.role_changed",
  "member.removed",
  "member.invited",
  "invitation.revoked",
  "invitation.accepted",
  "project.created",
  "project.updated",
  "project.deleted",
  "key.rotated",
  "key.revoked",
  "upload_token.created",
  "upload_token.revoked",
  "alert_rule.created",
  "alert_rule.updated",
  "alert_rule.deleted",
  "escalation_policy.created",
  "escalation_policy.updated",
  "escalation_policy.deleted",
  "schedule.created",
  "schedule.updated",
  "schedule.deleted",
  "channel.created",
  "channel.updated",
  "channel.deleted",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditEntry = {
  orgId: string;
  action: AuditAction;
  targetType: string;
  targetId?: string | null;
  data?: Record<string, unknown>;
};

// Who did it comes from the request: the signed-in user and their IP.
// Pass `tx` to write it in the same transaction as the change: both happen, or neither.
export async function audit(request: FastifyRequest, entry: AuditEntry, tx: Tx | typeof db = db) {
  await tx.insert(auditLog).values({
    ...entry,
    data: entry.data ?? {},
    actorId: request.user?.id ?? null,
    ip: request.ip,
  });
}

// Only the names of what changed, never the values: a webhook URL or a
// phone number shouldn't be copied into the log
export const changedFields = (changes: object) => ({ fields: Object.keys(changes) });
