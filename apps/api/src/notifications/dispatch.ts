import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db, type Tx } from "../db/client.js";
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
import { loadPolicy, resolveLevelTargets } from "../escalation/service.js";
import { levelForStep } from "../escalation/steps.js";
import { getFirstResponder } from "../incidents/responder.js";
import { addTimeline } from "../incidents/service.js";
import type { EscalationTarget, TimelineData } from "../incidents/timeline.js";
import {
  type ChannelConfig,
  type ChannelType,
  type DeliveryStatus,
  type DeliveryTrigger,
  escalationTrigger,
} from "./channels.js";
import {
  type IncidentDetails,
  incidentMessage,
  type NotificationMessage,
  testMessage,
} from "./message.js";
import { type Notifier, type NotifierRegistry, PermanentError } from "./notifier.js";

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
        escalationPolicyId: incidents.escalationPolicyId,
        escalationStep: incidents.escalationStep,
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

// Who hears about an incident, as long as it's at least as severe as the channel asks for:
// - team: the org's own channels (webhooks, team inboxes)
// - users: these people's own channels, or "members" for everyone in the org.
//   Only current members: someone who left hears nothing, even if a schedule names them.
type Audience = { team: boolean; users: string[] | "members" };

export function channelsFor(orgId: string, severity: Severity, { team, users }: Audience) {
  const people = db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, orgId),
        users === "members" ? undefined : inArray(memberships.userId, users),
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
        or(
          team ? eq(notificationChannels.orgId, orgId) : undefined,
          inArray(notificationChannels.userId, people),
        ),
      ),
    );
}

type Channel = typeof notificationChannels.$inferSelect;

// One pending log row per channel (a retry inserts nothing new), then every
// delivery for this trigger that still has to be sent
async function queueDeliveries(
  incidentId: string,
  orgId: string,
  trigger: DeliveryTrigger,
  channels: Channel[],
  tx: Tx | typeof db = db,
) {
  if (channels.length > 0) {
    await tx
      .insert(notificationLog)
      .values(
        channels.map((channel) => ({
          incidentId,
          channelId: channel.id,
          orgId,
          channelType: channel.type,
          recipient: recipientLabel(channel.type, channel.config),
          trigger,
        })),
      )
      .onConflictDoNothing();
  }
}

async function pendingDeliveries(incidentId: string, trigger: DeliveryTrigger) {
  const rows = await db
    .select({ id: notificationLog.id })
    .from(notificationLog)
    .where(
      and(
        eq(notificationLog.incidentId, incidentId),
        eq(notificationLog.trigger, trigger),
        eq(notificationLog.status, "pending"),
      ),
    );
  return rows.map((row) => row.id);
}

// Step 1 ("incident" job): pick who responds first, then one pending log row per channel.
// With an escalation policy (F14) that's its level 1; without one, the project's
// on-call person (F13). Returns the deliveries still to send. Safe to run twice.
export async function planIncidentNotifications(incidentId: string): Promise<string[]> {
  const details = await loadIncidentDetails(incidentId);
  if (details?.incident.status !== "triggered") return [];
  const { org, incident } = details;
  const now = new Date();

  const policy = incident.escalationPolicyId ? await loadPolicy(incident.escalationPolicyId) : null;
  const firstLevel = policy?.levels[0];

  let targets: EscalationTarget[] | null = null;
  let responder: TimelineData["notified"]["responder"] = null;
  if (policy && firstLevel) {
    targets = await resolveLevelTargets(firstLevel, now);
  } else {
    const onCall = await getFirstResponder(details.project.id, now);
    const [user] = onCall
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(eq(users.id, onCall.userId))
      : [];
    if (user && onCall) responder = { ...user, source: onCall.source };
  }
  const people = targets ? targets.map((target) => target.id) : responder ? [responder.id] : [];

  let channels = await channelsFor(org.id, incident.severity, { team: true, users: people });
  // Nobody to ask, or they have no channel for this severity: better to wake everyone than no one
  const everyone = !channels.some((channel) => channel.userId && people.includes(channel.userId));
  if (everyone) {
    channels = await channelsFor(org.id, incident.severity, { team: true, users: "members" });
  }
  await queueDeliveries(incidentId, org.id, "incident_triggered", channels);

  const responderId = people[0];
  if (responderId) {
    await db
      .update(incidents)
      .set({ responderId })
      .where(and(eq(incidents.id, incidentId), isNull(incidents.responderId)));
  }
  // With a policy, the next level is due after level 1's timeout (F14)
  if (policy && firstLevel) {
    await db
      .update(incidents)
      .set({ nextEscalationAt: new Date(now.getTime() + firstLevel.timeoutMinutes * 60_000) })
      .where(
        and(
          eq(incidents.id, incidentId),
          eq(incidents.status, "triggered"),
          eq(incidents.escalationStep, 0),
          isNull(incidents.nextEscalationAt),
        ),
      );
  }

  await addTimeline(db, incidentId, "notified", {
    responder,
    everyone,
    channels: channels.length,
    ...(policy && targets
      ? { escalation: { policy: { id: policy.id, name: policy.name }, targets } }
      : {}),
  });

  return pendingDeliveries(incidentId, "incident_triggered");
}

// Step 1b ("escalate" job, F14): nobody acknowledged during the last level's timeout,
// so notify the next level. Does nothing if the incident was acknowledged or resolved
// meanwhile, or if this step already ran (a duplicate or late job).
export async function escalateIncident(
  incidentId: string,
  step: number,
  now = new Date(),
): Promise<string[]> {
  const details = await loadIncidentDetails(incidentId);
  if (!details) return [];
  const { incident, org } = details;
  if (incident.status !== "triggered" || incident.escalationStep !== step - 1) return [];

  const policy = incident.escalationPolicyId ? await loadPolicy(incident.escalationPolicyId) : null;
  const position = policy ? levelForStep(policy.levels.length, policy.repeatCount, step) : null;
  const level = position ? policy?.levels[position.levelIndex] : undefined;

  // Who to tell, worked out before the transaction (it may ask the schedules)
  const targets = level ? await resolveLevelTargets(level, now) : [];
  const channels = targets.length
    ? await channelsFor(org.id, incident.severity, {
        team: false, // team channels heard about it when it opened
        users: targets.map((target) => target.id),
      })
    : [];
  const trigger = escalationTrigger(step);

  const moved = await db.transaction(async (tx) => {
    // The guard: only one job can move the incident from step - 1 to step,
    // and only while nobody has acknowledged it
    const [row] = await tx
      .update(incidents)
      .set({
        escalationStep: step,
        nextEscalationAt: level ? new Date(now.getTime() + level.timeoutMinutes * 60_000) : null,
      })
      .where(
        and(
          eq(incidents.id, incidentId),
          eq(incidents.status, "triggered"),
          eq(incidents.escalationStep, step - 1),
        ),
      )
      .returning({ id: incidents.id });
    if (!row) return false;

    if (policy && position && level) {
      await queueDeliveries(incidentId, org.id, trigger, channels, tx);
      await addTimeline(
        tx,
        incidentId,
        "escalated",
        {
          step,
          level: position.levelIndex + 1,
          pass: position.pass + 1,
          targets,
          channels: channels.length,
        },
        null,
        now,
      );
    } else if (policy) {
      await addTimeline(
        tx,
        incidentId,
        "exhausted",
        { levels: policy.levels.length, passes: policy.repeatCount + 1 },
        null,
        now,
      );
    }
    return true;
  });

  return moved && level ? pendingDeliveries(incidentId, trigger) : [];
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
    message = incidentMessage(details, deliveryId, channel.userId, {
      escalated: delivery.trigger.startsWith("escalation_"),
    });
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
