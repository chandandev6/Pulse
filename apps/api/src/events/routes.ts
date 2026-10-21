import cors from "@fastify/cors";
import { EventSchema } from "@pulse/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../db/client.js";
import { projectKeys } from "../db/schema.js";
import { AppError } from "../errors.js";
import { parse } from "../validate.js";
import { eventsQueue } from "./queue.js";

type IngestRequest = FastifyRequest<{
  Params: { projectId: string };
  Querystring: { pulse_key?: string };
}>;

// Bigger reports are refused with 413 before we even read them
const MAX_EVENT_BYTES = 200 * 1024;

// SDKs prove which project they report to with the DSN's public key.
// Header normally; query string for browser APIs that can't set headers (sendBeacon).
async function requireProjectKey(request: IngestRequest) {
  const key = request.headers["x-pulse-key"] ?? request.query.pulse_key;
  const { projectId } = request.params;

  const [found] =
    typeof key === "string" && z.uuid().safeParse(projectId).success
      ? await db
          .select({ id: projectKeys.id })
          .from(projectKeys)
          .where(
            and(
              eq(projectKeys.publicKey, key),
              eq(projectKeys.projectId, projectId),
              isNull(projectKeys.revokedAt),
            ),
          )
      : [];

  // Same answer for missing, wrong, revoked or other-project keys
  if (!found) throw new AppError(401, "INVALID_KEY", "Missing, invalid or revoked project key");
}

// Registered with prefix "/api" in app.ts
export async function ingestRoutes(app: FastifyInstance) {
  // Registered inside this plugin, so CORS only opens up /api/* routes to other websites,
  // not the dashboard routes that use cookies. No cookies here: the key is the proof.
  await app.register(cors, {
    origin: "*",
    methods: ["POST"],
    allowedHeaders: ["Content-Type", "X-Pulse-Key"],
    maxAge: 86_400, // browsers may cache the preflight answer for a day
  });

  app.post(
    "/:projectId/events",
    { bodyLimit: MAX_EVENT_BYTES, preHandler: requireProjectKey },
    async (request: IngestRequest, reply) => {
      const event = parse(EventSchema, request.body);

      // Don't save here: queue it and answer right away, so a flood of errors
      // can't slow down the apps reporting them. The worker saves it.
      await eventsQueue.add("event", {
        projectId: request.params.projectId,
        receivedAt: new Date().toISOString(),
        event,
      });

      return reply.code(202).send({ id: event.event_id });
    },
  );
}
