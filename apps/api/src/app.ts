import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { sql } from "drizzle-orm";
import Fastify from "fastify";
import { alertRoutes } from "./alerts/routes.js";
import { authRoutes } from "./auth/routes.js";
import { db, pool } from "./db/client.js";
import { registerErrorHandlers } from "./errors.js";
import { escalationRoutes } from "./escalation/routes.js";
import { eventsQueue } from "./events/queue.js";
import { ingestRoutes } from "./events/routes.js";
import { incidentRoutes } from "./incidents/routes.js";
import { issueRoutes } from "./issues/routes.js";
import { loggerOptions } from "./logger.js";
import { notificationsQueue } from "./notifications/queue.js";
import { notificationRoutes } from "./notifications/routes.js";
import { orgRoutes } from "./orgs/routes.js";
import { projectRoutes } from "./projects/routes.js";
import { rateLimitOptions } from "./rate-limit.js";
import { redis } from "./redis.js";
import { releaseRoutes } from "./releases/routes.js";
import { scheduleRoutes } from "./schedules/routes.js";

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
  const app = Fastify({ logger: loggerOptions });

  registerErrorHandlers(app);

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
  app.register(projectRoutes);
  app.register(issueRoutes);
  app.register(releaseRoutes);
  app.register(alertRoutes);
  app.register(incidentRoutes);
  app.register(escalationRoutes);
  app.register(notificationRoutes);
  app.register(scheduleRoutes);
  app.register(ingestRoutes, { prefix: "/api" });

  app.get("/health", async (_request, reply) => {
    const [dbStatus, redisStatus] = await Promise.all([
      check(() => db.execute(sql`SELECT 1`)),
      check(() => redis.ping()),
    ]);

    const healthy = dbStatus === "ok" && redisStatus === "ok";

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? "ok" : "degraded",
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
