import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { incidents } from "../db/schema.js";
import { queueConnection } from "../events/queue.js";
import { deliver, escalateIncident, planIncidentNotifications } from "./dispatch.js";
import type { NotifierRegistry } from "./notifier.js";
import {
  enqueueDeliveries,
  NOTIFICATIONS_QUEUE,
  type NotificationJob,
  scheduleEscalationJob,
} from "./queue.js";
import { defaultNotifiers } from "./registry.js";

// F14: if the incident still waits for someone and a next level is due, set a
// delayed job for it. The database (next_escalation_at) is the source of truth.
export async function scheduleNextEscalation(incidentId: string) {
  const [incident] = await db
    .select({
      status: incidents.status,
      step: incidents.escalationStep,
      nextAt: incidents.nextEscalationAt,
    })
    .from(incidents)
    .where(eq(incidents.id, incidentId));
  if (incident?.status !== "triggered" || !incident.nextAt) return null;
  await scheduleEscalationJob(incidentId, incident.step + 1, incident.nextAt);
  return { step: incident.step + 1, at: incident.nextAt };
}

type Attempt = { attemptsMade: number; attempts: number };

// What one job does. Separate from the Worker, so tests can run it directly.
export async function handleNotificationJob(
  data: NotificationJob,
  { attemptsMade, attempts }: Attempt,
  notifiers: NotifierRegistry,
) {
  switch (data.kind) {
    case "incident": {
      const deliveryIds = await planIncidentNotifications(data.incidentId);
      await enqueueDeliveries(deliveryIds);
      const next = await scheduleNextEscalation(data.incidentId);
      return { deliveries: deliveryIds.length, nextEscalation: next?.at ?? null };
    }
    case "escalate": {
      const deliveryIds = await escalateIncident(data.incidentId, data.step);
      await enqueueDeliveries(deliveryIds);
      const next = await scheduleNextEscalation(data.incidentId);
      return { deliveries: deliveryIds.length, nextEscalation: next?.at ?? null };
    }
    case "deliver": {
      // attemptsMade counts the tries *before* this one
      const isLastAttempt = attemptsMade + 1 >= attempts;
      const status = await deliver(data.deliveryId, { notifiers, isLastAttempt });
      return { status };
    }
  }
}

export function createNotificationWorker(notifiers: NotifierRegistry = defaultNotifiers()) {
  return new Worker<NotificationJob>(
    NOTIFICATIONS_QUEUE,
    (job) =>
      handleNotificationJob(
        job.data,
        { attemptsMade: job.attemptsMade, attempts: job.opts.attempts ?? 1 },
        notifiers,
      ),
    // Sending is mostly waiting on the network, so many can run at once
    { connection: queueConnection, concurrency: 20 },
  );
}
