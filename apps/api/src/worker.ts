import { pino } from "pino";
import { pool } from "./db/client.js";
import { createEventWorker } from "./events/worker.js";
import { loggerOptions } from "./logger.js";

// A separate process from the API: `pnpm worker`.
// The API only puts events in the queue; this saves them. Each can be scaled on its own.
const log = pino(loggerOptions || { enabled: false });
const worker = createEventWorker();

worker.on("ready", () => log.info("Event worker ready, waiting for jobs"));
worker.on("completed", (job, result) => log.debug({ jobId: job.id, ...result }, "Event processed"));
worker.on("failed", (job, err) => log.error({ jobId: job?.id, err }, "Event failed"));

async function shutdown(signal: NodeJS.Signals) {
  log.info(`${signal} received, finishing current jobs...`);
  await worker.close(); // waits for running jobs, takes no new ones
  await pool.end();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
