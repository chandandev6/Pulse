import { and, asc, desc, eq, getTableColumns } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/require-auth.js";
import { SESSION_COOKIE, validateSession } from "../auth/session.js";
import { db } from "../db/client.js";
import {
  alertRules,
  INCIDENT_STATUSES,
  incidents,
  incidentTimeline,
  issues,
  memberships,
  notificationLog,
  projects,
  type Role,
  users,
} from "../db/schema.js";
import { AppError } from "../errors.js";
import { verifyAckToken } from "../notifications/links.js";
import { forbidden, hasRole, requireProjectRole } from "../orgs/access.js";
import { parse } from "../validate.js";
import { type AckResult, acknowledgeIncident, type Incident, resolveIncident } from "./service.js";

type ProjectParams = { projectId: string };
type IncidentParams = { incidentId: string };

declare module "fastify" {
  interface FastifyRequest {
    // Set by requireIncidentRole
    incident: Incident;
  }
}

const IncidentQuerySchema = z.object({
  status: z.enum(INCIDENT_STATUSES).optional(),
  ruleId: z.uuid().optional(),
});

const ResolveSchema = z.object({ resolveIssue: z.boolean().default(false) }).default({
  resolveIssue: false,
});

const TokenQuerySchema = z.object({ token: z.string().min(1).max(500) });

// The one-click links are public (no login), so each IP gets a limited number of tries
const linkRateLimit = { max: 30, timeWindow: "10 minutes" };

const isId = (value: string) => z.uuid().safeParse(value).success;
const incidentNotFound = () => new AppError(404, "INCIDENT_NOT_FOUND", "Incident not found");
const invalidLink = () =>
  new AppError(403, "INVALID_LINK", "This link is invalid or has expired. Open Pulse to respond.");

// The same idea as requireIssueRole: incident → project → org → your membership
function requireIncidentRole(minRole: Role) {
  return async (request: FastifyRequest) => {
    const { incidentId } = request.params as IncidentParams;
    const [row] = isId(incidentId)
      ? await db
          .select({
            incident: getTableColumns(incidents),
            orgId: projects.orgId,
            role: memberships.role,
          })
          .from(incidents)
          .innerJoin(projects, eq(projects.id, incidents.projectId))
          .innerJoin(
            memberships,
            and(eq(memberships.orgId, projects.orgId), eq(memberships.userId, request.user.id)),
          )
          .where(eq(incidents.id, incidentId))
      : [];

    if (!row) throw incidentNotFound();
    if (!hasRole(row.role, minRole)) throw forbidden(minRole);
    request.membership = { orgId: row.orgId, role: row.role };
    request.incident = row.incident;
  };
}

// Several people per incident, so the users table is joined under different names
const responder = alias(users, "responder");
const acknowledger = alias(users, "acknowledger");
const resolver = alias(users, "resolver");

const incidentSummary = {
  id: incidents.id,
  title: incidents.title,
  status: incidents.status,
  severity: incidents.severity,
  issueId: incidents.issueId,
  triggeredAt: incidents.triggeredAt,
  acknowledgedAt: incidents.acknowledgedAt,
  resolvedAt: incidents.resolvedAt,
  rule: { id: alertRules.id, name: alertRules.name },
  responder: { id: responder.id, name: responder.name },
  acknowledgedBy: { id: acknowledger.id, name: acknowledger.name },
  resolvedBy: { id: resolver.id, name: resolver.name },
};

function sendAck(reply: FastifyReply, result: AckResult) {
  if (result.ok) return { incident: result.incident };
  const who = result.acknowledgedBy?.name ?? "someone else";
  return reply.code(409).send({
    error: {
      code: "ALREADY_ACKNOWLEDGED",
      message: `${who} already acknowledged this incident`,
      acknowledgedBy: result.acknowledgedBy,
      acknowledgedAt: result.acknowledgedAt,
    },
  });
}

// Checks a one-click link and works out who is using it: the person it was
// sent to, or (for team channels like webhooks) whoever is logged in.
// Either way they must still be a member of the incident's org.
async function linkUser(request: FastifyRequest, incidentId: string, token: string) {
  if (!isId(incidentId)) throw invalidLink();
  const verified = verifyAckToken(incidentId, token);
  if (!verified) throw invalidLink();

  const sessionToken = request.cookies[SESSION_COOKIE];
  const sessionUser = sessionToken ? await validateSession(sessionToken) : null;
  const userId = verified.userId ?? sessionUser?.id ?? null;

  const [row] = await db
    .select({
      incident: {
        id: incidents.id,
        title: incidents.title,
        severity: incidents.severity,
        status: incidents.status,
        triggeredAt: incidents.triggeredAt,
        acknowledgedAt: incidents.acknowledgedAt,
        resolvedAt: incidents.resolvedAt,
      },
      project: { id: projects.id, name: projects.name, orgId: projects.orgId },
      acknowledgedBy: { id: acknowledger.id, name: acknowledger.name },
    })
    .from(incidents)
    .innerJoin(projects, eq(projects.id, incidents.projectId))
    .leftJoin(acknowledger, eq(acknowledger.id, incidents.acknowledgedBy))
    .where(eq(incidents.id, incidentId));
  if (!row) throw invalidLink();

  const [user] = userId
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .innerJoin(
          memberships,
          and(eq(memberships.userId, users.id), eq(memberships.orgId, row.project.orgId)),
        )
        .where(eq(users.id, userId))
    : [];
  // A personal link for someone who has left the org stops working
  if (verified.userId && !user) throw invalidLink();

  const { orgId: _orgId, ...project } = row.project;
  return { ...row, project, user: user ?? null };
}

export async function incidentRoutes(app: FastifyInstance) {
  // Newest first, e.g. ?status=triggered for "what still needs someone?"
  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/incidents",
    { preHandler: [requireAuth, requireProjectRole("member")] },
    async (request) => {
      const query = parse(IncidentQuerySchema, request.query);
      const rows = await db
        .select(incidentSummary)
        .from(incidents)
        .leftJoin(alertRules, eq(alertRules.id, incidents.ruleId))
        .leftJoin(responder, eq(responder.id, incidents.responderId))
        .leftJoin(acknowledger, eq(acknowledger.id, incidents.acknowledgedBy))
        .leftJoin(resolver, eq(resolver.id, incidents.resolvedBy))
        .where(
          and(
            eq(incidents.projectId, request.project.id),
            query.status ? eq(incidents.status, query.status) : undefined,
            query.ruleId ? eq(incidents.ruleId, query.ruleId) : undefined,
          ),
        )
        .orderBy(desc(incidents.triggeredAt))
        .limit(50);

      return { incidents: rows };
    },
  );

  // One incident with its whole story: the timeline and every notification sent
  app.get<{ Params: IncidentParams }>(
    "/incidents/:incidentId",
    { preHandler: [requireAuth, requireIncidentRole("member")] },
    async (request) => {
      const id = request.incident.id;
      const actor = alias(users, "actor");

      const [[incident], timeline, deliveries] = await Promise.all([
        db
          .select({
            ...incidentSummary,
            project: { id: projects.id, name: projects.name },
            issue: {
              id: issues.id,
              title: issues.title,
              culprit: issues.culprit,
              status: issues.status,
              eventCount: issues.eventCount,
              userCount: issues.userCount,
              lastSeen: issues.lastSeen,
            },
          })
          .from(incidents)
          .innerJoin(projects, eq(projects.id, incidents.projectId))
          .innerJoin(issues, eq(issues.id, incidents.issueId))
          .leftJoin(alertRules, eq(alertRules.id, incidents.ruleId))
          .leftJoin(responder, eq(responder.id, incidents.responderId))
          .leftJoin(acknowledger, eq(acknowledger.id, incidents.acknowledgedBy))
          .leftJoin(resolver, eq(resolver.id, incidents.resolvedBy))
          .where(eq(incidents.id, id)),
        db
          .select({
            id: incidentTimeline.id,
            kind: incidentTimeline.kind,
            data: incidentTimeline.data,
            createdAt: incidentTimeline.createdAt,
            actor: { id: actor.id, name: actor.name },
          })
          .from(incidentTimeline)
          .leftJoin(actor, eq(actor.id, incidentTimeline.actorId))
          .where(eq(incidentTimeline.incidentId, id))
          .orderBy(asc(incidentTimeline.createdAt), asc(incidentTimeline.id)),
        db
          .select({
            id: notificationLog.id,
            channelType: notificationLog.channelType,
            recipient: notificationLog.recipient,
            status: notificationLog.status,
            attempts: notificationLog.attempts,
            error: notificationLog.error,
            createdAt: notificationLog.createdAt,
            sentAt: notificationLog.sentAt,
          })
          .from(notificationLog)
          .where(eq(notificationLog.incidentId, id))
          .orderBy(asc(notificationLog.createdAt)),
      ]);

      return { incident, timeline, deliveries };
    },
  );

  // Any member can take an incident: whoever is on call usually does
  app.post<{ Params: IncidentParams }>(
    "/incidents/:incidentId/acknowledge",
    { preHandler: [requireAuth, requireIncidentRole("member")] },
    async (request, reply) =>
      sendAck(reply, await acknowledgeIncident(request.incident.id, request.user.id, "dashboard")),
  );

  app.post<{ Params: IncidentParams }>(
    "/incidents/:incidentId/resolve",
    { preHandler: [requireAuth, requireIncidentRole("member")] },
    async (request) => {
      const body = parse(ResolveSchema, request.body ?? undefined);
      const incident = await resolveIncident(request.incident.id, request.user.id, body);
      return { incident };
    },
  );

  // ---------- One-click links from notifications ----------
  //
  // Opening the link only *shows* the incident (GET). Acknowledging is a separate
  // POST from the page's button, because email scanners open every link they see:
  // a GET that acknowledged would "take" incidents nobody actually looked at.

  app.get<{ Params: IncidentParams }>(
    "/incidents/:incidentId/link",
    { config: { rateLimit: linkRateLimit } },
    async (request) => {
      const { token } = parse(TokenQuerySchema, request.query);
      const { incident, project, acknowledgedBy, user } = await linkUser(
        request,
        request.params.incidentId,
        token,
      );
      // A team link (webhook, shared inbox) doesn't say who you are: log in first
      return { incident, project, acknowledgedBy, user, needsLogin: user === null };
    },
  );

  app.post<{ Params: IncidentParams }>(
    "/incidents/:incidentId/link/acknowledge",
    { config: { rateLimit: linkRateLimit } },
    async (request, reply) => {
      const { token } = parse(TokenQuerySchema, request.body);
      const { incident, user } = await linkUser(request, request.params.incidentId, token);
      if (!user) throw new AppError(401, "UNAUTHENTICATED", "Log in to acknowledge this incident");
      return sendAck(reply, await acknowledgeIncident(incident.id, user.id, "link"));
    },
  );
}
