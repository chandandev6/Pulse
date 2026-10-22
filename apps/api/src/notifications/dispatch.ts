import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  alertRules,
  incidents,
  issues,
  memberships,
  notificationChannels,
  notificationLog,
  organizations,
  projects,
  type Severity,
  users,
} from "../db/schema.js";
import { getFirstResponder } from "../incidents/responder.js";
import { addTimeline } from "../incidents/service.js";
import type { ChannelConfig, ChannelType, DeliveryStatus } from "./channels.js";
import {
  type IncidentDetails,
  incidentMessage,
  type NotificationMessage,
  testMessage,
} from "./message.js";
import { type Notifier, type NotifierRegistry, PermanentError } from "./notifier.js";

type Channel = typeof notificationChannels.$inferSelect;

// How a channel is shown in the delivery log. Phone numbers are partly hidden.
export function recipientLabel(type: ChannelType, config: ChannelConfig): string {
  if ("address" in config) return config.address;
  if ("phone" in config) return `${config.phone.slice(0, 3)}•••••${config.phone.slice(-3)}`;
  if ("endpoint" in config) return `Browser (${new URL(config.endpoint).hostname})`;
  if ("url" in config) return new URL(config.url).host;
  return type;
}

export async function loadIncidentDetails(incidentId: string): Promise<IncidentDetails | null> {
  const [row] = await db
    .select({
      incident: {
        id: incidents.id,
        title: incidents.title,
        severity: incidents.severity,
        status: incidents.status,
        triggeredAt: incidents.triggeredAt,
      },
      issue: {
        id: issues.id,
        title: issues.title,
        culprit: issues.culprit,
        eventCount: issues.eventCount,
        userCount: issues.userCount,
        firstSeen: issues.firstSeen,
        lastSeen: issues.lastSeen,
        lastRelease: issues.lastRelease,
      },
      project: { id: projects.id, name: projects.name },
      org: { id: organizations.id, name: organizations.name },
      rule: { id: alertRules.id, name: alertRules.name },
    })
    .from(incidents)
    .innerJoin(issues, eq(issues.id, incidents.issueId))
    .innerJoin(projects, eq(projects.id, incidents.projectId))
    .innerJoin(organizations, eq(organizations.id, projects.orgId))
    .leftJoin(alertRules, eq(alertRules.id, incidents.ruleId))
    .where(eq(incidents.id, incidentId));
  return row ?? null;
}

// Who hears about an incident: the org's team channels, plus people's own channels
// (only the responder's when someone is on call, otherwise every member's),
// as long as the incident is at least as severe as the channel asks for.
export function channelsForIncident(orgId: string, severity: Severity, responderId: string | null) {
  // Still a member: someone who left the org hears nothing, even if a schedule names them
  const people = db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, orgId),
        responderId ? eq(memberships.userId, responderId) : undefined,
      ),
    );

  return db
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.enabled, true),
        // enums compare in declaration order: low < medium < high < critical
        lte(notificationChannels.minSeverity, severity),
        or(eq(notificationChannels.orgId, orgId), inArray(notificationChannels.userId, people)),
      ),
    );
}

// Step 1 ("incident" job): pick the first responder, then one pending log row per channel.
// Returns the deliveries still to send. Safe to run twice: the unique index on
// (incident, channel, trigger) turns the second insert into a no-op.
export async function planIncidentNotifications(incidentId: string): Promise<string[]> {
  const details = await loadIncidentDetails(incidentId);
  if (!details || details.incident.status !== "triggered") return [];
  const { org, incident } = details;

  const onCall = await getFirstResponder(details.project.id, new Date());
  const [responder] = onCall
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(eq(users.id, onCall.userId))
    : [];

  let channels = await channelsForIncident(org.id, incident.severity, responder?.id ?? null);
  // The on-call person has no channel for this severity: better to wake everyone than no one
  const everyone = !responder || !channels.some((channel) => channel.userId === responder.id);
  if (responder && everyone) channels = await channelsForIncident(org.id, incident.severity, null);

  if (channels.length > 0) {
    await db
      .insert(notificationLog)
      .values(
        channels.map((channel) => ({
          incidentId,
          channelId: channel.id,
          orgId: org.id,
          channelType: channel.type,
          recipient: recipientLabel(channel.type, channel.config),
          trigger: "incident_triggered" as const,
        })),
      )
      .onConflictDoNothing();
  }

  if (responder) {
    await db
      .update(incidents)
      .set({ responderId: responder.id })
      .where(and(eq(incidents.id, incidentId), isNull(incidents.responderId)));
  }
  await addTimeline(db, incidentId, "notified", {
    responder: responder && onCall ? { ...responder, source: onCall.source } : null,
    everyone,
    channels: channels.length,
  });

  const pending = await db
    .select({ id: notificationLog.id })
    .from(notificationLog)
    .where(
      and(
        eq(notificationLog.incidentId, incidentId),
        eq(notificationLog.trigger, "incident_triggered"),
        eq(notificationLog.status, "pending"),
      ),
    );
  return pending.map((row) => row.id);
}

// The "Send test" button: a log row with no incident
export async function createTestDelivery(channel: Channel) {
  const [row] = await db
    .insert(notificationLog)
    .values({
      channelId: channel.id,
      orgId: channel.orgId,
      channelType: channel.type,
      recipient: recipientLabel(channel.type, channel.config),
      trigger: "test",
    })
    .returning();
  if (!row) throw new Error("test delivery not created");
  return row;
}

async function finish(deliveryId: string, status: DeliveryStatus, error: string | null = null) {
  await db
    .update(notificationLog)
    .set({ status, error, sentAt: status === "sent" ? new Date() : null })
    .where(eq(notificationLog.id, deliveryId));
  return status;
}

type DeliverOptions = { notifiers: NotifierRegistry; isLastAttempt: boolean };

// Step 2 ("deliver" job): send one message to one channel and record what happened.
// Throwing = "try again later" (BullMQ retries with backoff). Returning = done.
export async function deliver(
  deliveryId: string,
  { notifiers, isLastAttempt }: DeliverOptions,
): Promise<DeliveryStatus | "missing"> {
  const [row] = await db
    .select({ delivery: notificationLog, channel: notificationChannels })
    .from(notificationLog)
    .leftJoin(notificationChannels, eq(notificationChannels.id, notificationLog.channelId))
    .where(eq(notificationLog.id, deliveryId));
  if (!row) return "missing";
  const { delivery, channel } = row;
  if (delivery.status !== "pending") return delivery.status; // already handled by an earlier try

  if (!channel?.enabled)
    return finish(deliveryId, "skipped", "The channel was removed or turned off");
  const notifier: Notifier = notifiers[channel.type];
  if (!notifier.isConfigured()) {
    return finish(deliveryId, "skipped", `${channel.type} is not set up on this server`);
  }

  let message: NotificationMessage;
  if (delivery.incidentId) {
    const details = await loadIncidentDetails(delivery.incidentId);
    if (!details) return finish(deliveryId, "skipped", "The incident no longer exists");
    // Someone already took it (F13): no need to wake anyone else
    if (details.incident.status !== "triggered") {
      return finish(deliveryId, "skipped", `The incident is already ${details.incident.status}`);
    }
    message = incidentMessage(details, deliveryId, channel.userId);
  } else {
    message = testMessage(deliveryId, channel.name);
  }

  await db
    .update(notificationLog)
    .set({ attempts: sql`${notificationLog.attempts} + 1` })
    .where(eq(notificationLog.id, deliveryId));

  try {
    await notifier.send(channel.config, message);
    return finish(deliveryId, "sent");
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (err instanceof PermanentError) {
      if (err.disableChannel) {
        await db
          .update(notificationChannels)
          .set({ enabled: false, updatedAt: new Date() })
          .where(eq(notificationChannels.id, channel.id));
      }
      return finish(deliveryId, "failed", error);
    }
    if (isLastAttempt) return finish(deliveryId, "failed", error);

    // Keep it pending, remember why, and let BullMQ try again
    await db.update(notificationLog).set({ error }).where(eq(notificationLog.id, deliveryId));
    throw err;
  }
}
