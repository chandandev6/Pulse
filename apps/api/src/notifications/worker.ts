import { Worker } from "bullmq";
import { queueConnection } from "../events/queue.js";
import { deliver, planIncidentNotifications } from "./dispatch.js";
import type { NotifierRegistry } from "./notifier.js";
import { enqueueDeliveries, NOTIFICATIONS_QUEUE, type NotificationJob } from "./queue.js";
import { defaultNotifiers } from "./registry.js";

export function createNotificationWorker(notifiers: NotifierRegistry = defaultNotifiers()) {
  return new Worker<NotificationJob>(
    NOTIFICATIONS_QUEUE,
    async (job) => {
      if (job.data.kind === "incident") {
        const deliveryIds = await planIncidentNotifications(job.data.incidentId);
        await enqueueDeliveries(deliveryIds);
        return { deliveries: deliveryIds.length };
      }

      // attemptsMade counts the tries *before* this one
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const status = await deliver(job.data.deliveryId, { notifiers, isLastAttempt });
      return { status };
    },
    // Sending is mostly waiting on the network, so many can run at once
    { connection: queueConnection, concurrency: 20 },
  );
}
