import { sql } from "drizzle-orm";
import Fastify from "fastify";
import { authRoutes } from "./auth/routes.js";
import { db, pool } from "./db/client.js";
import { registerErrorHandlers } from "./errors.js";
import { loggerOptions } from "./logger.js";
import { redis } from "./redis.js";

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

  app.register(authRoutes);

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
    await pool.end();
    await redis.quit();
  });

  return app;
}
