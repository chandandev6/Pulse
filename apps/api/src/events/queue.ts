import type { PulseEvent } from "@pulse/shared";
import { Queue } from "bullmq";
import { config } from "../config.js";

export const EVENTS_QUEUE = "events";

// BullMQ opens its own Redis connections: its blocking reads need different
// settings from our normal `redis` client.
export const queueConnection = { url: config.REDIS_URL };

// What travels through the queue: the checked event plus who it belongs to
export type EventJob = {
  projectId: string;
  receivedAt: string; // ISO date; jobs are stored as JSON, so no Date objects
  event: PulseEvent;
};

export const eventsQueue = new Queue<EventJob>(EVENTS_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 5, // if saving fails (e.g. Postgres restarting), try again...
    backoff: { type: "exponential", delay: 1_000 }, // ...after 1s, 2s, 4s, 8s
    removeOnComplete: 1_000, // keep only the last 1000 finished jobs in Redis
    removeOnFail: 5_000, // keep failed jobs longer, to investigate
  },
});
