import { Worker } from "bullmq";
import { enqueueIncidentNotifications } from "../notifications/queue.js";
import { symbolicate } from "../sourcemaps/symbolicate.js";
import { EVENTS_QUEUE, type EventJob, queueConnection } from "./queue.js";
import { saveEvent } from "./store.js";

// Takes jobs off the queue and saves them. A thrown error makes BullMQ retry the job.
export function createEventWorker() {
  return new Worker<EventJob>(
    EVENTS_QUEUE,
    async (job) => {
      // Minified browser frames → real files and lines, before grouping (see symbolicate.ts)
      const saved = await saveEvent(await symbolicate(job.data));
      // Only after the transaction committed: the notification worker must find the incident
      if (saved) await enqueueIncidentNotifications(saved.incidentIds);
      return { saved: saved !== null, incidents: saved?.incidentIds.length ?? 0 };
    },
    { connection: queueConnection, concurrency: 10 },
  );
}
