import { Queue } from "bullmq";
import { queueConnection } from "../events/queue.js";

export const NOTIFICATIONS_QUEUE = "notifications";

// Two kinds of job:
// - "incident": an incident just opened → decide who to tell (one log row per channel)
// - "deliver": send one message to one channel. Each has its own retries, so a
//   webhook that's down doesn't delay (or repeat!) the emails.
export type NotificationJob =
  | { kind: "incident"; incidentId: string }
  | { kind: "deliver"; deliveryId: string };

export const DELIVERY_ATTEMPTS = 6;

export const notificationsQueue = new Queue<NotificationJob>(NOTIFICATIONS_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: DELIVERY_ATTEMPTS,
    backoff: { type: "exponential", delay: 5_000 }, // 5s, 10s, 20s, 40s, 80s
    removeOnComplete: 1_000,
    removeOnFail: 5_000,
  },
});

// The job id makes adding the same job twice harmless: BullMQ ignores a job
// whose id it already has. (Ids can't contain ":", so we use "-".)
export async function enqueueIncidentNotifications(incidentIds: string[]) {
  if (incidentIds.length === 0) return;
  await notificationsQueue.addBulk(
    incidentIds.map((incidentId) => ({
      name: "incident",
      data: { kind: "incident", incidentId },
      opts: { jobId: `incident-${incidentId}` },
    })),
  );
}

export async function enqueueDeliveries(deliveryIds: string[]) {
  if (deliveryIds.length === 0) return;
  await notificationsQueue.addBulk(
    deliveryIds.map((deliveryId) => ({
      name: "deliver",
      data: { kind: "deliver", deliveryId },
      opts: { jobId: `deliver-${deliveryId}` },
    })),
  );
}
