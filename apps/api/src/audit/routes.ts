import { and, desc, eq, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/require-auth.js";
import { db } from "../db/client.js";
import { auditLog, users } from "../db/schema.js";
import { requireOrgRole } from "../orgs/access.js";
import { afterCursor, decodeCursor, encodeCursor, PageQuerySchema, pageOf } from "../pagination.js";
import { parse } from "../validate.js";
import { AUDIT_ACTIONS } from "./log.js";

type OrgParams = { orgId: string };

const AuditQuerySchema = PageQuerySchema.extend({
  action: z.enum(AUDIT_ACTIONS).optional(),
  actorId: z.uuid().optional(),
});

const SORT = "created";

export async function auditRoutes(app: FastifyInstance) {
  // Newest first. Admins only: it shows who changed what, and from which IP.
  app.get<{ Params: OrgParams }>(
    "/orgs/:orgId/audit-log",
    { preHandler: [requireAuth, requireOrgRole("admin")] },
    async (request) => {
      const { limit, cursor, action, actorId } = parse(AuditQuerySchema, request.query);

      const filters: (SQL | undefined)[] = [eq(auditLog.orgId, request.membership.orgId)];
      if (action) filters.push(eq(auditLog.action, action));
      if (actorId) filters.push(eq(auditLog.actorId, actorId));
      if (cursor) {
        filters.push(
          afterCursor(auditLog.createdAt, auditLog.id, decodeCursor(cursor, SORT), true),
        );
      }

      const rows = await db
        .select({
          id: auditLog.id,
          action: auditLog.action,
          targetType: auditLog.targetType,
          targetId: auditLog.targetId,
          data: auditLog.data,
          ip: auditLog.ip,
          createdAt: auditLog.createdAt,
          actor: { id: users.id, name: users.name, email: users.email },
        })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actorId))
        .where(and(...filters))
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(limit + 1);

      const { items, nextCursor } = pageOf(rows, limit, (last) =>
        encodeCursor(SORT, last.createdAt, last.id),
      );
      // A deleted account leaves actor_id null: the left join gives an all-null actor
      return {
        entries: items.map((entry) => ({ ...entry, actor: entry.actor?.id ? entry.actor : null })),
        nextCursor,
      };
    },
  );
}
