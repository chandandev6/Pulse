import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, changedFields } from "../audit/log.js";
import { requireAuth, requireVerifiedEmail } from "../auth/require-auth.js";
import { db } from "../db/client.js";
import { isUniqueViolation } from "../db/errors.js";
import { projectKeys, projects, schedules } from "../db/schema.js";
import { AppError } from "../errors.js";
import { monthlyUsage } from "../events/quota.js";
import { requireOrgRole, requireProjectRole } from "../orgs/access.js";
import { slugify, withFreeSlug } from "../slug.js";
import { parse } from "../validate.js";
import { createProjectKey, toKeyResponse } from "./keys.js";
import { CreateProjectSchema, UpdateProjectSchema } from "./schemas.js";

type OrgParams = { orgId: string };
type ProjectParams = { projectId: string };
type KeyParams = { projectId: string; keyId: string };

const slugTaken = () =>
  new AppError(409, "SLUG_TAKEN", "A project in this organization already uses this slug");

export async function projectRoutes(app: FastifyInstance) {
  // Creating a project also creates its first key, in one transaction
  app.post<{ Params: OrgParams }>(
    "/orgs/:orgId/projects",
    { preHandler: [requireAuth, requireVerifiedEmail, requireOrgRole("admin")] },
    async (request, reply) => {
      const { name, slug, platform } = parse(CreateProjectSchema, request.body);
      const { orgId } = request.params;

      const result = await db.transaction(async (tx) => {
        const insertProject = (slug: string) =>
          tx
            .insert(projects)
            .values({ orgId, name, slug, platform })
            .onConflictDoNothing({ target: [projects.orgId, projects.slug] })
            .returning()
            .then(([project]) => project);

        const project = slug
          ? await insertProject(slug)
          : await withFreeSlug(slugify(name, "project"), insertProject);
        if (!project) return null;

        const key = await createProjectKey(tx, project.id);
        await audit(
          request,
          {
            orgId,
            action: "project.created",
            targetType: "project",
            targetId: project.id,
            data: { name: project.name },
          },
          tx,
        );
        return { project, key };
      });
      if (!result) throw slugTaken();

      return reply.code(201).send({
        project: { ...result.project, dsn: toKeyResponse(result.key).dsn },
      });
    },
  );

  app.get<{ Params: OrgParams }>(
    "/orgs/:orgId/projects",
    { preHandler: [requireAuth, requireOrgRole("member")] },
    async (request) => {
      const rows = await db
        .select()
        .from(projects)
        .where(eq(projects.orgId, request.params.orgId))
        .orderBy(projects.createdAt);

      return { projects: rows };
    },
  );

  // Members can read keys: they need the DSN to set up the SDK
  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId",
    { preHandler: [requireAuth, requireProjectRole("member")] },
    async (request) => {
      const [keys, eventsThisMonth] = await Promise.all([
        db
          .select()
          .from(projectKeys)
          .where(eq(projectKeys.projectId, request.project.id))
          .orderBy(desc(projectKeys.createdAt)),
        monthlyUsage(request.project.id),
      ]);

      return {
        project: request.project,
        keys: keys.map(toKeyResponse),
        usage: { eventsThisMonth },
      };
    },
  );

  app.patch<{ Params: ProjectParams }>(
    "/projects/:projectId",
    { preHandler: [requireAuth, requireProjectRole("admin")] },
    async (request) => {
      const changes = parse(UpdateProjectSchema, request.body);
      if (changes.onCallScheduleId) {
        // Only one of this org's schedules
        const [schedule] = await db
          .select({ id: schedules.id })
          .from(schedules)
          .where(
            and(
              eq(schedules.id, changes.onCallScheduleId),
              eq(schedules.orgId, request.project.orgId),
            ),
          );
        if (!schedule) {
          throw new AppError(
            400,
            "INVALID_SCHEDULE",
            "Pick an on-call schedule of this organization",
          );
        }
      }

      try {
        const [project] = await db
          .update(projects)
          .set({ ...changes, updatedAt: new Date() })
          .where(eq(projects.id, request.project.id))
          .returning();
        await audit(request, {
          orgId: request.project.orgId,
          action: "project.updated",
          targetType: "project",
          targetId: request.project.id,
          data: changedFields(changes),
        });
        return { project };
      } catch (err) {
        if (isUniqueViolation(err, "projects_org_id_slug_unique")) throw slugTaken();
        throw err;
      }
    },
  );

  // Deletes the project and (by cascade) its keys and, later, all its events
  app.delete<{ Params: ProjectParams }>(
    "/projects/:projectId",
    { preHandler: [requireAuth, requireProjectRole("admin")] },
    async (request, reply) => {
      const { id, orgId, name } = request.project;
      await db.transaction(async (tx) => {
        await tx.delete(projects).where(eq(projects.id, id));
        await audit(
          request,
          { orgId, action: "project.deleted", targetType: "project", targetId: id, data: { name } },
          tx,
        );
      });
      return reply.code(204).send();
    },
  );

  // Rotate = revoke every active key and issue a fresh one, all or nothing.
  // Use it when a key leaked: apps must switch to the new DSN.
  app.post<{ Params: ProjectParams }>(
    "/projects/:projectId/keys/rotate",
    { preHandler: [requireAuth, requireProjectRole("admin")] },
    async (request, reply) => {
      const projectId = request.project.id;

      const key = await db.transaction(async (tx) => {
        await tx
          .update(projectKeys)
          .set({ revokedAt: new Date() })
          .where(and(eq(projectKeys.projectId, projectId), isNull(projectKeys.revokedAt)));
        const created = await createProjectKey(tx, projectId);
        await audit(
          request,
          {
            orgId: request.project.orgId,
            action: "key.rotated",
            targetType: "project",
            targetId: projectId,
            data: { keyId: created.id },
          },
          tx,
        );
        return created;
      });

      return reply.code(201).send({ key: toKeyResponse(key) });
    },
  );

  app.post<{ Params: KeyParams }>(
    "/projects/:projectId/keys/:keyId/revoke",
    { preHandler: [requireAuth, requireProjectRole("admin")] },
    async (request) => {
      const { keyId } = request.params;
      const projectId = request.project.id;
      const keyNotFound = () => new AppError(404, "KEY_NOT_FOUND", "Key not found");
      if (!z.uuid().safeParse(keyId).success) throw keyNotFound();
      const sameKey = and(eq(projectKeys.id, keyId), eq(projectKeys.projectId, projectId));

      // Revoking twice is fine: the first revoked_at is kept
      const [revoked] = await db
        .update(projectKeys)
        .set({ revokedAt: new Date() })
        .where(and(sameKey, isNull(projectKeys.revokedAt)))
        .returning();
      if (revoked) {
        await audit(request, {
          orgId: request.project.orgId,
          action: "key.revoked",
          targetType: "project",
          targetId: projectId,
          data: { keyId },
        });
        return { key: toKeyResponse(revoked) };
      }

      const [existing] = await db.select().from(projectKeys).where(sameKey);
      if (!existing) throw keyNotFound();
      return { key: toKeyResponse(existing) };
    },
  );
}
