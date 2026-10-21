import { and, eq, getTableColumns } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../db/client.js";
import { events, issues, memberships, projects, type Role } from "../db/schema.js";
import { AppError } from "../errors.js";

export type Membership = { orgId: string; role: Role };
export type Project = typeof projects.$inferSelect;
export type Issue = typeof issues.$inferSelect;
export type StoredEvent = typeof events.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    // Set by every require*Role guard
    membership: Membership;
    // Set by requireProjectRole
    project: Project;
    // Set by requireIssueRole
    issue: Issue;
    // Set by requireEventRole
    event: StoredEvent;
  }
}

const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1 };

export function hasRole(role: Role, minRole: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

export function forbidden(minRole: Role) {
  return new AppError(403, "FORBIDDEN", `This needs the ${minRole} role or higher`);
}

const isId = (value: unknown) => z.uuid().safeParse(value).success;

// Use after requireAuth: { preHandler: [requireAuth, requireOrgRole("admin")] }
// Not a member → 404, so outsiders can't even tell the org exists.
// A member whose role is too low → 403 (they already know it exists).
export function requireOrgRole(minRole: Role) {
  return async (request: FastifyRequest) => {
    const { orgId } = request.params as { orgId: string };

    const [row] = isId(orgId)
      ? await db
          .select({ role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, request.user.id)))
      : [];

    if (!row) throw new AppError(404, "ORG_NOT_FOUND", "Organization not found");
    if (!hasRole(row.role, minRole)) throw forbidden(minRole);
    request.membership = { orgId, role: row.role };
  };
}

// Same idea for /projects/:projectId routes: a project belongs to an org,
// so your access to a project is your role in its org.
export function requireProjectRole(minRole: Role) {
  return async (request: FastifyRequest) => {
    const { projectId } = request.params as { projectId: string };

    const [row] = isId(projectId)
      ? await db
          .select({ project: getTableColumns(projects), role: memberships.role })
          .from(projects)
          .innerJoin(
            memberships,
            and(eq(memberships.orgId, projects.orgId), eq(memberships.userId, request.user.id)),
          )
          .where(eq(projects.id, projectId))
      : [];

    if (!row) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
    if (!hasRole(row.role, minRole)) throw forbidden(minRole);
    request.membership = { orgId: row.project.orgId, role: row.role };
    request.project = row.project;
  };
}

// The org a project belongs to, joined with *your* membership in it.
// No membership row → the join finds nothing → 404.
const yourMembership = (userId: string) =>
  and(eq(memberships.orgId, projects.orgId), eq(memberships.userId, userId));

// Issues and events belong to a project, so access goes issue → project → org
export function requireIssueRole(minRole: Role) {
  return async (request: FastifyRequest) => {
    const { issueId } = request.params as { issueId: string };

    const [row] = isId(issueId)
      ? await db
          .select({ issue: getTableColumns(issues), orgId: projects.orgId, role: memberships.role })
          .from(issues)
          .innerJoin(projects, eq(projects.id, issues.projectId))
          .innerJoin(memberships, yourMembership(request.user.id))
          .where(eq(issues.id, issueId))
      : [];

    if (!row) throw new AppError(404, "ISSUE_NOT_FOUND", "Issue not found");
    if (!hasRole(row.role, minRole)) throw forbidden(minRole);
    request.membership = { orgId: row.orgId, role: row.role };
    request.issue = row.issue;
  };
}

export function requireEventRole(minRole: Role) {
  return async (request: FastifyRequest) => {
    const { eventId } = request.params as { eventId: string };

    const [row] = isId(eventId)
      ? await db
          .select({ event: getTableColumns(events), orgId: projects.orgId, role: memberships.role })
          .from(events)
          .innerJoin(projects, eq(projects.id, events.projectId))
          .innerJoin(memberships, yourMembership(request.user.id))
          .where(eq(events.id, eventId))
      : [];

    if (!row) throw new AppError(404, "EVENT_NOT_FOUND", "Event not found");
    if (!hasRole(row.role, minRole)) throw forbidden(minRole);
    request.membership = { orgId: row.orgId, role: row.role };
    request.event = row.event;
  };
}
