import { Queue } from "bullmq";
import { queueConnection } from "../events/queue.js";
import type { Mail } from "../mail/mailer.js";

export const NOTIFICATIONS_QUEUE = "notifications";

// Three kinds of job:
// - "incident": an incident just opened → decide who to tell (one log row per channel)
// - "deliver": send one message to one channel. Each has its own retries, so a
//   webhook that's down doesn't delay (or repeat!) the emails.
// - "escalate" (F14): a delayed job. If nobody acknowledged in time, tell the next level.
// - "mail": one account email (password reset, verification, invitation)
export type NotificationJob =
  | { kind: "incident"; incidentId: string }
  | { kind: "deliver"; deliveryId: string }
  | { kind: "escalate"; incidentId: string; step: number }
  | { kind: "mail"; mail: Mail };

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

const escalationJobId = (incidentId: string, step: number) => `escalate-${incidentId}-${step}`;

// Wakes up at `at` to try escalation step `step`. Waiting is BullMQ's job (a delayed
// job), so nothing polls. The job id makes scheduling the same step twice harmless.
export async function scheduleEscalationJob(incidentId: string, step: number, at: Date) {
  await notificationsQueue.add(
    "escalate",
    { kind: "escalate", incidentId, step },
    { jobId: escalationJobId(incidentId, step), delay: Math.max(0, at.getTime() - Date.now()) },
  );
}

// Acknowledged or resolved: the waiting escalation isn't needed any more.
// (If it still runs, it sees the new status and does nothing; this just tidies up.)
export async function cancelEscalationJob(incidentId: string, step: number) {
  await notificationsQueue.remove(escalationJobId(incidentId, step));
}

// Account emails go through the worker too: a slow SMTP server never slows the request,
// and a failed send is retried. Their links are secrets, so the job is deleted from Redis
// as soon as it's done instead of being kept like the others.
export async function enqueueMail(mail: Mail) {
  await notificationsQueue.add(
    "mail",
    { kind: "mail", mail },
    { removeOnComplete: true, removeOnFail: true },
  );
}
