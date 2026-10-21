import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/require-auth.js";
import { db } from "../db/client.js";
import { isUniqueViolation } from "../db/errors.js";
import { projectKeys, projects } from "../db/schema.js";
import { AppError } from "../errors.js";
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
    { preHandler: [requireAuth, requireOrgRole("admin")] },
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
      const keys = await db
        .select()
        .from(projectKeys)
        .where(eq(projectKeys.projectId, request.project.id))
        .orderBy(desc(projectKeys.createdAt));

      return { project: request.project, keys: keys.map(toKeyResponse) };
    },
  );

  app.patch<{ Params: ProjectParams }>(
    "/projects/:projectId",
    { preHandler: [requireAuth, requireProjectRole("admin")] },
    async (request) => {
      const changes = parse(UpdateProjectSchema, request.body);

      try {
        const [project] = await db
          .update(projects)
          .set({ ...changes, updatedAt: new Date() })
          .where(eq(projects.id, request.project.id))
          .returning();
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
      await db.delete(projects).where(eq(projects.id, request.project.id));
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
        return createProjectKey(tx, projectId);
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
      if (revoked) return { key: toKeyResponse(revoked) };

      const [existing] = await db.select().from(projectKeys).where(sameKey);
      if (!existing) throw keyNotFound();
      return { key: toKeyResponse(existing) };
    },
  );
}
