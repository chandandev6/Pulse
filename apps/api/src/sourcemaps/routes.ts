import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { TraceMap } from "@jridgewell/trace-mapping";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../audit/log.js";
import { requireAuth } from "../auth/require-auth.js";
import { hashToken } from "../auth/session.js";
import { db } from "../db/client.js";
import { sourceMaps, uploadTokens } from "../db/schema.js";
import { AppError } from "../errors.js";
import { requireProjectRole } from "../orgs/access.js";
import { parse } from "../validate.js";
import { minifiedName } from "./symbolicate.js";

// A big app's main bundle map can be several MB
export const MAX_SOURCE_MAP_BYTES = 20 * 1024 * 1024;

type ProjectParams = { projectId: string };
type TokenParams = { projectId: string; tokenId: string };

const NameSchema = z.object({ name: z.string().trim().min(1).max(100) });
const DeleteMapsSchema = z.object({ release: z.string().min(1).max(200) });
const UploadQuery = z.object({
  release: z.string().trim().min(1).max(200),
  // the map's file name ("index-abc.js.map") or path ("assets/index-abc.js.map")
  name: z.string().trim().min(1).max(500),
});

const tokenNotFound = () => new AppError(404, "TOKEN_NOT_FOUND", "Upload token not found");

// Dashboard side: upload tokens and the list of uploaded maps
export async function sourceMapRoutes(app: FastifyInstance) {
  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/upload-tokens",
    { preHandler: [requireAuth, requireProjectRole("admin")] },
    async (request) => {
      const tokens = await db
        .select({
          id: uploadTokens.id,
          name: uploadTokens.name,
          lastUsedAt: uploadTokens.lastUsedAt,
          createdAt: uploadTokens.createdAt,
        })
        .from(uploadTokens)
        .where(eq(uploadTokens.projectId, request.project.id))
        .orderBy(uploadTokens.createdAt);
      return { tokens };
    },
  );

  // The token is shown once, in this answer. Only its hash is stored.
  app.post<{ Params: ProjectParams }>(
    "/projects/:projectId/upload-tokens",
    { preHandler: [requireAuth, requireProjectRole("admin")] },
    async (request, reply) => {
      const { name } = parse(NameSchema, request.body);
      const token = `pulse_ut_${randomBytes(32).toString("base64url")}`;
      const [created] = await db
        .insert(uploadTokens)
        .values({
          projectId: request.project.id,
          name,
          tokenHash: hashToken(token),
          createdBy: request.user.id,
        })
        .returning({
          id: uploadTokens.id,
          name: uploadTokens.name,
          createdAt: uploadTokens.createdAt,
        });
      if (!created) throw new Error("token not created");
      await audit(request, {
        orgId: request.project.orgId,
        action: "upload_token.created",
        targetType: "upload_token",
        targetId: created.id,
        data: { name, projectId: request.project.id },
      });
      return reply.code(201).send({ token: { ...created, lastUsedAt: null }, secret: token });
    },
  );

  app.delete<{ Params: TokenParams }>(
    "/projects/:projectId/upload-tokens/:tokenId",
    { preHandler: [requireAuth, requireProjectRole("admin")] },
    async (request, reply) => {
      const { tokenId } = request.params;
      if (!z.uuid().safeParse(tokenId).success) throw tokenNotFound();
      const [deleted] = await db
        .delete(uploadTokens)
        .where(and(eq(uploadTokens.id, tokenId), eq(uploadTokens.projectId, request.project.id)))
        .returning({ name: uploadTokens.name });
      if (!deleted) throw tokenNotFound();
      await audit(request, {
        orgId: request.project.orgId,
        action: "upload_token.revoked",
        targetType: "upload_token",
        targetId: tokenId,
        data: { name: deleted.name, projectId: request.project.id },
      });
      return reply.code(204).send();
    },
  );

  // Uploaded maps grouped by release, newest first (not their content)
  app.get<{ Params: ProjectParams }>(
    "/projects/:projectId/sourcemaps",
    { preHandler: [requireAuth, requireProjectRole("member")] },
    async (request) => {
      const releases = await db
        .select({
          release: sourceMaps.release,
          files: sql<number>`count(*)::int`,
          bytes: sql<number>`sum(${sourceMaps.size})::int`,
          uploadedAt: sql<Date>`max(${sourceMaps.createdAt})`,
        })
        .from(sourceMaps)
        .where(eq(sourceMaps.projectId, request.project.id))
        .groupBy(sourceMaps.release)
        .orderBy(desc(sql`max(${sourceMaps.createdAt})`))
        .limit(50);
      return { releases };
    },
  );

  app.delete<{ Params: ProjectParams }>(
    "/projects/:projectId/sourcemaps",
    { preHandler: [requireAuth, requireProjectRole("admin")] },
    async (request, reply) => {
      const { release } = parse(DeleteMapsSchema, request.query);
      await db
        .delete(sourceMaps)
        .where(and(eq(sourceMaps.projectId, request.project.id), eq(sourceMaps.release, release)));
      return reply.code(204).send();
    },
  );
}

declare module "fastify" {
  interface FastifyRequest {
    // Set by requireUploadToken
    uploadProjectId: string;
  }
}

// CI sends "Authorization: Bearer pulse_ut_..." (a cookie wouldn't make sense for a script)
async function requireUploadToken(request: FastifyRequest<{ Params: ProjectParams }>) {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const { projectId } = request.params;

  const [found] =
    token && z.uuid().safeParse(projectId).success
      ? await db
          .update(uploadTokens)
          .set({ lastUsedAt: new Date() })
          .where(
            and(
              eq(uploadTokens.tokenHash, hashToken(token)),
              eq(uploadTokens.projectId, projectId),
            ),
          )
          .returning({ projectId: uploadTokens.projectId })
      : [];
  if (!found) throw new AppError(401, "INVALID_TOKEN", "Missing or invalid upload token");
  request.uploadProjectId = found.projectId;
}

// Registered with prefix "/api" in app.ts, next to ingestion:
//   curl -X PUT "https://pulse.example.com/api/<project>/sourcemaps?release=1.4.2&name=index-abc.js.map" \
//     -H "Authorization: Bearer pulse_ut_..." --data-binary @dist/assets/index-abc.js.map
export async function sourceMapUploadRoutes(app: FastifyInstance) {
  app.decorateRequest("uploadProjectId", "");
  // The map arrives as raw bytes: we store it as it is, and only parse it to check it
  // (this plugin's own parsers: the rest of the API keeps parsing JSON normally)
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    ["application/octet-stream", "application/json"],
    { parseAs: "buffer", bodyLimit: MAX_SOURCE_MAP_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.put<{ Params: ProjectParams }>(
    "/:projectId/sourcemaps",
    {
      bodyLimit: MAX_SOURCE_MAP_BYTES,
      preHandler: requireUploadToken,
      config: { rateLimit: { max: 300, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      const { release, name } = parse(UploadQuery, request.query);
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new AppError(400, "INVALID_SOURCE_MAP", "Send the source map file as the body");
      }

      try {
        const map = JSON.parse(body.toString("utf8"));
        if (map?.version !== 3) throw new Error("not version 3");
        new TraceMap(map); // throws on mappings it can't read
      } catch {
        throw new AppError(400, "INVALID_SOURCE_MAP", "This is not a valid source map (version 3)");
      }

      // Frames look maps up by the minified file's name: "index-abc.js.map" → "index-abc.js"
      const file = minifiedName(name).replace(/\.map$/, "");
      const values = { content: gzipSync(body), size: body.length, createdAt: new Date() };
      await db
        .insert(sourceMaps)
        .values({ projectId: request.uploadProjectId, release, name: file, ...values })
        .onConflictDoUpdate({
          target: [sourceMaps.projectId, sourceMaps.release, sourceMaps.name],
          set: values,
        });

      return reply.code(201).send({ release, name: file, size: body.length });
    },
  );
}
