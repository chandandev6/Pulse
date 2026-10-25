import { randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit/log.js";
import { requireAuth, requireVerifiedEmail } from "../auth/require-auth.js";
import { hashToken } from "../auth/session.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { invitations, memberships, organizations, users } from "../db/schema.js";
import { AppError } from "../errors.js";
import { invitationMail } from "../mail/templates.js";
import { enqueueMail } from "../notifications/queue.js";
import { parse } from "../validate.js";
import { forbidden, requireOrgRole } from "./access.js";
import { AddMemberSchema } from "./schemas.js";

const INVITATION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

type OrgParams = { orgId: string };
type InvitationParams = { orgId: string; invitationId: string };

const TokenSchema = z.object({ token: z.string().min(20).max(200) });

const invalidInvitation = () =>
  new AppError(404, "INVITATION_NOT_FOUND", "This invitation has expired or was already used");

// What admins see in the list (never the token: it only exists in the email)
const publicColumns = {
  id: invitations.id,
  email: invitations.email,
  role: invitations.role,
  expiresAt: invitations.expiresAt,
  createdAt: invitations.createdAt,
};

const stillValid = () => gt(invitations.expiresAt, new Date());

// The invitation behind a token, with what the "join" page shows
async function findByToken(token: string) {
  const [row] = await db
    .select({
      id: invitations.id,
      orgId: invitations.orgId,
      email: invitations.email,
      role: invitations.role,
      orgName: organizations.name,
      inviterName: users.name,
    })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .leftJoin(users, eq(users.id, invitations.invitedBy))
    .where(and(eq(invitations.tokenHash, hashToken(token)), stillValid()));
  return row ?? null;
}

// Invite by email: works whether or not they have an account yet. They join only when
// they click the link and accept, logged in as anyone (the link itself is the proof).
export async function invitationRoutes(app: FastifyInstance) {
  app.post<{ Params: OrgParams }>(
    "/orgs/:orgId/invitations",
    {
      preHandler: [requireAuth, requireVerifiedEmail, requireOrgRole("admin")],
      config: { rateLimit: { max: 20, timeWindow: "1 hour" } }, // invitations are emails to strangers
    },
    async (request, reply) => {
      const { email, role } = parse(AddMemberSchema, request.body);
      const { orgId } = request.params;
      if (role === "owner" && request.membership.role !== "owner") throw forbidden("owner");

      const [member] = await db
        .select({ userId: memberships.userId })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.orgId, orgId), eq(users.email, email)));
      if (member) throw new AppError(409, "ALREADY_MEMBER", "This person is already a member");

      // Inviting the same email again sends a fresh link; the old one stops working
      const token = randomBytes(32).toString("base64url");
      const values = {
        role,
        tokenHash: hashToken(token),
        invitedBy: request.user.id,
        expiresAt: new Date(Date.now() + INVITATION_DAYS * DAY_MS),
      };
      const [invitation] = await db
        .insert(invitations)
        .values({ orgId, email, ...values })
        .onConflictDoUpdate({
          target: [invitations.orgId, invitations.email],
          set: { ...values, createdAt: new Date() },
        })
        .returning(publicColumns);
      if (!invitation) throw new Error("invitation not saved");

      const [org] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, orgId));
      const url = `${config.WEB_PUBLIC_URL}/invite#token=${token}`;
      await enqueueMail(invitationMail(email, request.user.name, org?.name ?? "an org", url));
      await audit(request, {
        orgId,
        action: "member.invited",
        targetType: "invitation",
        targetId: invitation.id,
        data: { email, role },
      });

      return reply.code(201).send({ invitation });
    },
  );

  app.get<{ Params: OrgParams }>(
    "/orgs/:orgId/invitations",
    { preHandler: [requireAuth, requireOrgRole("admin")] },
    async (request) => {
      const rows = await db
        .select(publicColumns)
        .from(invitations)
        .where(and(eq(invitations.orgId, request.params.orgId), stillValid()))
        .orderBy(invitations.createdAt);
      return { invitations: rows };
    },
  );

  app.delete<{ Params: InvitationParams }>(
    "/orgs/:orgId/invitations/:invitationId",
    { preHandler: [requireAuth, requireOrgRole("admin")] },
    async (request, reply) => {
      const { orgId, invitationId } = request.params;
      if (!z.uuid().safeParse(invitationId).success) throw invalidInvitation();
      const [deleted] = await db
        .delete(invitations)
        .where(and(eq(invitations.id, invitationId), eq(invitations.orgId, orgId)))
        .returning({ email: invitations.email });
      if (!deleted) throw invalidInvitation();
      await audit(request, {
        orgId,
        action: "invitation.revoked",
        targetType: "invitation",
        targetId: invitationId,
        data: { email: deleted.email },
      });
      return reply.code(204).send();
    },
  );

  // Public: the join page shows who invited you where, before you log in or sign up
  app.post(
    "/invitations/preview",
    { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } },
    async (request) => {
      const { token } = parse(TokenSchema, request.body);
      const invitation = await findByToken(token);
      if (!invitation) throw invalidInvitation();
      const { orgName, inviterName, email, role } = invitation;
      return { invitation: { orgName, inviterName, email, role } };
    },
  );

  app.post(
    "/invitations/accept",
    { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } },
    async (request) => {
      const { token } = parse(TokenSchema, request.body);
      const user = request.user;

      const result = await db.transaction(async (tx) => {
        // Deleting first makes accepting single-use, even with two clicks at the same moment
        const [invitation] = await tx
          .delete(invitations)
          .where(and(eq(invitations.tokenHash, hashToken(token)), stillValid()))
          .returning({
            orgId: invitations.orgId,
            email: invitations.email,
            role: invitations.role,
          });
        if (!invitation) throw invalidInvitation();

        const [joined] = await tx
          .insert(memberships)
          .values({ userId: user.id, orgId: invitation.orgId, role: invitation.role })
          .onConflictDoNothing()
          .returning({ role: memberships.role });

        // The invitation reached this inbox, so the address works
        if (invitation.email === user.email) {
          await tx
            .update(users)
            .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
            .where(eq(users.id, user.id));
        }
        if (joined) {
          await audit(
            request,
            {
              orgId: invitation.orgId,
              action: "invitation.accepted",
              targetType: "member",
              targetId: user.id,
              data: { email: user.email, invitedEmail: invitation.email, role: invitation.role },
            },
            tx,
          );
        }
        return { orgId: invitation.orgId, alreadyMember: !joined };
      });

      return result;
    },
  );
}
