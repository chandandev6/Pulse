import { pino } from "pino";
import { pool } from "./db/client.js";
import { createEventWorker } from "./events/worker.js";
import { loggerOptions } from "./logger.js";
import { notificationsQueue } from "./notifications/queue.js";
import { createNotificationWorker } from "./notifications/worker.js";

// A separate process from the API: `pnpm worker`.
// The API only puts events in the queue; this saves them. Each can be scaled on its own.
const log = pino(loggerOptions || { enabled: false });
const worker = createEventWorker();
// F11: sends notifications for the incidents the event worker opens
const notificationWorker = createNotificationWorker();

worker.on("ready", () => log.info("Event worker ready, waiting for jobs"));
worker.on("completed", (job, result) => log.debug({ jobId: job.id, ...result }, "Event processed"));
worker.on("failed", (job, err) => log.error({ jobId: job?.id, err }, "Event failed"));

notificationWorker.on("ready", () => log.info("Notification worker ready"));
notificationWorker.on("completed", (job, result) =>
  log.info({ jobId: job.id, ...result }, "Notification job done"),
);
// A failed try is normal (it will be retried); the log row records the final outcome
notificationWorker.on("failed", (job, err) =>
  log.warn(
    { jobId: job?.id, attempt: job?.attemptsMade, err: err.message },
    "Notification try failed",
  ),
);

async function shutdown(signal: NodeJS.Signals) {
  log.info(`${signal} received, finishing current jobs...`);
  await Promise.all([worker.close(), notificationWorker.close()]); // finish running jobs, take no new ones
  await notificationsQueue.close(); // the event worker adds jobs to it
  await pool.end();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
