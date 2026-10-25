import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyRequest } from "fastify";
import { alertRoutes } from "./alerts/routes.js";
import { auditRoutes } from "./audit/routes.js";
import { authRoutes } from "./auth/routes.js";
import { config } from "./config.js";
import { db, pool } from "./db/client.js";
import { registerErrorHandlers } from "./errors.js";
import { escalationRoutes } from "./escalation/routes.js";
import { eventsQueue } from "./events/queue.js";
import { ingestRoutes } from "./events/routes.js";
import { incidentRoutes } from "./incidents/routes.js";
import { issueRoutes } from "./issues/routes.js";
import { loggerOptions } from "./logger.js";
import { Pulse } from "./monitoring.js";
import { notificationsQueue } from "./notifications/queue.js";
import { notificationRoutes } from "./notifications/routes.js";
import { isPublicAddress } from "./notifications/ssrf.js";
import { invitationRoutes } from "./orgs/invitations.js";
import { orgRoutes } from "./orgs/routes.js";
import { projectRoutes } from "./projects/routes.js";
import { rateLimitOptions } from "./rate-limit.js";
import { redis } from "./redis.js";
import { releaseRoutes } from "./releases/routes.js";
import { scheduleRoutes } from "./schedules/routes.js";
import { sourceMapRoutes, sourceMapUploadRoutes } from "./sourcemaps/routes.js";

type Status = "ok" | "down";

async function check(fn: () => Promise<unknown>): Promise<Status> {
  try {
    await fn();
    return "ok";
  } catch {
    return "down";
  }
}

export function buildApp() {
  // Behind a reverse proxy (nginx in docker-compose.prod.yml) every request comes from
  // the proxy; trustProxy makes request.ip the real client from X-Forwarded-For.
  // Trust only the hops you control (TRUST_PROXY=1 for nginx): with "true", a client
  // could send its own X-Forwarded-For and dodge every per-IP rate limit.
  const trust = config.TRUST_PROXY;
  const app = Fastify({
    logger: loggerOptions,
    // A number = trust that many hops (Fastify's types don't list numbers, so say it directly)
    trustProxy: typeof trust === "number" ? (_address: string, hop: number) => hop < trust : trust,
  });

  registerErrorHandlers(app);
  // Reports 5xx errors when monitoring is on (does nothing before Pulse.init)
  app.register(Pulse.fastifyPlugin, {
    getUser: (request: FastifyRequest) => (request.user ? { id: request.user.id } : undefined),
  });

  app.register(cookie);
  app.register(rateLimit, rateLimitOptions);
  app.decorateRequest("user"); // filled in by requireAuth
  app.decorateRequest("membership"); // filled in by requireOrgRole / requireProjectRole
  app.decorateRequest("project"); // filled in by requireProjectRole
  app.decorateRequest("issue"); // filled in by requireIssueRole
  app.decorateRequest("event"); // filled in by requireEventRole
  app.decorateRequest("schedule"); // filled in by requireScheduleRole
  app.decorateRequest("incident"); // filled in by requireIncidentRole
  app.decorateRequest("policy"); // filled in by requirePolicyRole
  app.register(authRoutes);
  app.register(orgRoutes);
  app.register(invitationRoutes);
  app.register(projectRoutes);
  app.register(issueRoutes);
  app.register(releaseRoutes);
  app.register(alertRoutes);
  app.register(incidentRoutes);
  app.register(escalationRoutes);
  app.register(notificationRoutes);
  app.register(scheduleRoutes);
  app.register(auditRoutes);
  app.register(sourceMapRoutes);
  app.register(ingestRoutes, { prefix: "/api" });
  app.register(sourceMapUploadRoutes, { prefix: "/api" });

  app.get("/health", async (request, reply) => {
    const [dbStatus, redisStatus] = await Promise.all([
      check(() => db.execute(sql`SELECT 1`)),
      check(() => redis.ping()),
    ]);

    const healthy = dbStatus === "ok" && redisStatus === "ok";

    const status = healthy ? "ok" : "degraded";
    // Visitors from the internet only learn up or down; the details (which part is
    // struggling) are for Docker's healthcheck and your own servers on a private network
    if (isPublicAddress(request.ip)) {
      return reply.code(healthy ? 200 : 503).send({ status });
    }
    return reply.code(healthy ? 200 : 503).send({
      status,
      db: dbStatus,
      redis: redisStatus,
      uptime: process.uptime(),
    });
  });

  app.addHook("onClose", async () => {
    await Promise.all([eventsQueue.close(), notificationsQueue.close()]);
    await pool.end();
    await redis.quit();
  });

  return app;
}
