import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { audit, changedFields } from "../audit/log.js";
import { requireAuth } from "../auth/require-auth.js";
import { db, type Tx } from "../db/client.js";
import { isUniqueViolation } from "../db/errors.js";
import { memberships, organizations, type Role, users } from "../db/schema.js";
import { AppError } from "../errors.js";
import { removeFromEscalationPolicies } from "../escalation/service.js";
import { removeFromSchedules } from "../schedules/service.js";
import { parse } from "../validate.js";
import { forbidden, hasRole, requireOrgRole } from "./access.js";
import { AddMemberSchema, ChangeRoleSchema, CreateOrgSchema, UpdateOrgSchema } from "./schemas.js";
import { createOrgWithOwner } from "./service.js";

type OrgParams = { orgId: string };
type MemberParams = { orgId: string; userId: string };

const slugTaken = () => new AppError(409, "SLUG_TAKEN", "This slug is already in use");

// Locks the org's owner rows until the transaction ends, so two owners
// demoting each other at the same moment can't leave the org with nobody in charge.
async function assertNotLastOwner(tx: Tx, orgId: string) {
  const owners = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "owner")))
    .for("update");
  if (owners.length <= 1) {
    throw new AppError(409, "LAST_OWNER", "An organization must keep at least one owner");
  }
}

async function findMember(tx: Tx, orgId: string, userId: string) {
  const [member] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
  if (!member) throw new AppError(404, "MEMBER_NOT_FOUND", "Member not found");
  return member;
}

export async function orgRoutes(app: FastifyInstance) {
  app.post("/orgs", { preHandler: requireAuth }, async (request, reply) => {
    const { name, slug } = parse(CreateOrgSchema, request.body);

    const organization = await db.transaction((tx) =>
      createOrgWithOwner(tx, { name, slug, ownerId: request.user.id }),
    );
    if (!organization) throw slugTaken();

    return reply.code(201).send({ organization });
  });

  // Only the orgs you're a member of: the join on memberships is the filter
  app.get("/orgs", { preHandler: requireAuth }, async (request) => {
    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        role: memberships.role,
        createdAt: organizations.createdAt,
      })
      .from(organizations)
      .innerJoin(memberships, eq(memberships.orgId, organizations.id))
      .where(eq(memberships.userId, request.user.id))
      .orderBy(organizations.createdAt);

    return { organizations: rows };
  });

  app.get<{ Params: OrgParams }>(
    "/orgs/:orgId",
    { preHandler: [requireAuth, requireOrgRole("member")] },
    async (request) => {
      const [org] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, request.params.orgId));

      return { organization: { ...org, role: request.membership.role } };
    },
  );

  app.patch<{ Params: OrgParams }>(
    "/orgs/:orgId",
    { preHandler: [requireAuth, requireOrgRole("admin")] },
    async (request) => {
      const changes = parse(UpdateOrgSchema, request.body);

      try {
        const [org] = await db
          .update(organizations)
          .set({ ...changes, updatedAt: new Date() })
          .where(eq(organizations.id, request.params.orgId))
          .returning();
        await audit(request, {
          orgId: request.params.orgId,
          action: "org.updated",
          targetType: "organization",
          targetId: request.params.orgId,
          data: changedFields(changes),
        });
        return { organization: { ...org, role: request.membership.role } };
      } catch (err) {
        if (isUniqueViolation(err, "organizations_slug_unique")) throw slugTaken();
        throw err;
      }
    },
  );

  app.get<{ Params: OrgParams }>(
    "/orgs/:orgId/members",
    { preHandler: [requireAuth, requireOrgRole("member")] },
    async (request) => {
      const members = await db
        .select({
          userId: users.id,
          email: users.email,
          name: users.name,
          role: memberships.role,
          joinedAt: memberships.createdAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.orgId, request.params.orgId))
        .orderBy(memberships.createdAt);

      return { members };
    },
  );

  // Adds someone who already has a Pulse account. Email invites come later.
  app.post<{ Params: OrgParams }>(
    "/orgs/:orgId/members",
    { preHandler: [requireAuth, requireOrgRole("admin")] },
    async (request, reply) => {
      const { email, role } = parse(AddMemberSchema, request.body);
      if (role === "owner" && request.membership.role !== "owner") throw forbidden("owner");

      const [user] = await db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.email, email));
      if (!user) throw new AppError(404, "USER_NOT_FOUND", "No Pulse account uses this email");

      const [added] = await db
        .insert(memberships)
        .values({ userId: user.id, orgId: request.params.orgId, role })
        .onConflictDoNothing()
        .returning({ role: memberships.role, joinedAt: memberships.createdAt });
      if (!added) throw new AppError(409, "ALREADY_MEMBER", "This user is already a member");
      await audit(request, {
        orgId: request.params.orgId,
        action: "member.added",
        targetType: "member",
        targetId: user.id,
        data: { email: user.email, role },
      });

      return reply.code(201).send({
        member: { userId: user.id, email: user.email, name: user.name, ...added },
      });
    },
  );

  app.patch<{ Params: MemberParams }>(
    "/orgs/:orgId/members/:userId",
    { preHandler: [requireAuth, requireOrgRole("admin")] },
    async (request) => {
      const { role: newRole } = parse(ChangeRoleSchema, request.body);
      const { orgId, userId } = request.params;
      const actorRole = request.membership.role;

      const role = await db.transaction(async (tx) => {
        const target = await findMember(tx, orgId, userId);
        // Only owners can create owners or touch an owner's role
        if ((target.role === "owner" || newRole === "owner") && actorRole !== "owner") {
          throw forbidden("owner");
        }
        if (target.role === "owner" && newRole !== "owner") await assertNotLastOwner(tx, orgId);

        await tx
          .update(memberships)
          .set({ role: newRole })
          .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
        await audit(
          request,
          {
            orgId,
            action: "member.role_changed",
            targetType: "member",
            targetId: userId,
            data: { from: target.role, to: newRole },
          },
          tx,
        );
        return newRole;
      });

      return { member: { userId, role } };
    },
  );

  // Admins can remove others; anyone can remove themselves (leave the org)
  app.delete<{ Params: MemberParams }>(
    "/orgs/:orgId/members/:userId",
    { preHandler: [requireAuth, requireOrgRole("member")] },
    async (request, reply) => {
      const { orgId, userId } = request.params;
      const actorRole: Role = request.membership.role;
      const leaving = userId === request.user.id;
      if (!leaving && !hasRole(actorRole, "admin")) throw forbidden("admin");

      await db.transaction(async (tx) => {
        const target = await findMember(tx, orgId, userId);
        if (target.role === "owner") {
          if (!leaving && actorRole !== "owner") throw forbidden("owner");
          await assertNotLastOwner(tx, orgId);
        }

        await tx
          .delete(memberships)
          .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
        // F12: someone who left can't be on call for this org any more
        await removeFromSchedules(tx, orgId, userId);
        // F14: ...or be escalated to
        await removeFromEscalationPolicies(tx, orgId, userId);
        await audit(
          request,
          {
            orgId,
            action: "member.removed",
            targetType: "member",
            targetId: userId,
            data: { role: target.role, left: leaving },
          },
          tx,
        );
      });

      return reply.code(204).send();
    },
  );
}
