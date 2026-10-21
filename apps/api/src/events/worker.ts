import { Worker } from "bullmq";
import { EVENTS_QUEUE, type EventJob, queueConnection } from "./queue.js";
import { saveEvent } from "./store.js";

// Takes jobs off the queue and saves them. A thrown error makes BullMQ retry the job.
export function createEventWorker() {
  return new Worker<EventJob>(
    EVENTS_QUEUE,
    async (job) => {
      const saved = await saveEvent(job.data);
      return { saved: saved !== null };
    },
    { connection: queueConnection, concurrency: 10 },
  );
}
