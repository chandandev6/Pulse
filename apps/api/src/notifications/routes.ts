import { and, count, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, changedFields } from "../audit/log.js";
import { requireAuth } from "../auth/require-auth.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { incidents, notificationChannels, notificationLog, SEVERITIES } from "../db/schema.js";
import { AppError } from "../errors.js";
import { requireOrgRole } from "../orgs/access.js";
import { parse } from "../validate.js";
import {
  type ChannelConfig,
  EmailConfig,
  PushConfig,
  SmsConfig,
  WebhookConfig,
} from "./channels.js";
import { createTestDelivery, recipientLabel } from "./dispatch.js";
import { enqueueDeliveries } from "./queue.js";
import { defaultNotifiers } from "./registry.js";
import { newWebhookSecret } from "./webhook.js";

type Channel = typeof notificationChannels.$inferSelect;
type OrgParams = { orgId: string };
type ChannelParams = { channelId: string };
type OrgChannelParams = OrgParams & ChannelParams;

const MAX_CHANNELS = 20; // per user or org: enough for real use, stops abuse

const Common = {
  name: z.string().trim().min(1).max(100).optional(),
  minSeverity: z.enum(SEVERITIES).default("low"),
};

// Your own contact methods
const CreateUserChannelSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("email"), ...Common, config: EmailConfig }),
  z.object({ type: z.literal("sms"), ...Common, config: SmsConfig }),
  z.object({ type: z.literal("push"), ...Common, config: PushConfig }),
]);

// The team's channels. A webhook's secret is made by us, never sent by the client.
const CreateOrgChannelSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("email"), ...Common, config: EmailConfig }),
  z.object({
    type: z.literal("webhook"),
    ...Common,
    config: z.object({ url: WebhookConfig.shape.url }),
  }),
]);

const UpdateChannelSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    minSeverity: z.enum(SEVERITIES),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "Send at least one field to update");

// Never send secrets back: a webhook's secret is shown once, a push subscription's keys never
function toPublic(channel: Channel) {
  const { config: channelConfig, ...rest } = channel;
  return {
    ...rest,
    target:
      "url" in channelConfig ? channelConfig.url : recipientLabel(channel.type, channelConfig),
  };
}

function defaultName(channelConfig: ChannelConfig) {
  if ("address" in channelConfig) return channelConfig.address;
  if ("phone" in channelConfig) return channelConfig.phone;
  if ("url" in channelConfig) return new URL(channelConfig.url).host;
  return "Browser";
}

const channelNotFound = () =>
  new AppError(404, "CHANNEL_NOT_FOUND", "Notification channel not found");

// Finds a channel only if it belongs to this owner: other people's ids look like they don't exist
async function findChannel(owner: { userId: string } | { orgId: string }, channelId: string) {
  if (!z.uuid().safeParse(channelId).success) throw channelNotFound();
  const [channel] = await db
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.id, channelId),
        "userId" in owner
          ? eq(notificationChannels.userId, owner.userId)
          : eq(notificationChannels.orgId, owner.orgId),
      ),
    );
  if (!channel) throw channelNotFound();
  return channel;
}

async function checkLimit(owner: { userId: string } | { orgId: string }) {
  const [row] = await db
    .select({ count: count() })
    .from(notificationChannels)
    .where(
      "userId" in owner
        ? eq(notificationChannels.userId, owner.userId)
        : eq(notificationChannels.orgId, owner.orgId),
    );
  if ((row?.count ?? 0) >= MAX_CHANNELS) {
    throw new AppError(409, "TOO_MANY_CHANNELS", `You can have up to ${MAX_CHANNELS} channels`);
  }
}

async function updateChannel(channel: Channel, body: unknown) {
  const changes = parse(UpdateChannelSchema, body);
  const [updated] = await db
    .update(notificationChannels)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(notificationChannels.id, channel.id))
    .returning();
  if (!updated) throw channelNotFound();
  return toPublic(updated);
}

async function sendTest(channel: Channel) {
  if (!channel.enabled) {
    throw new AppError(409, "CHANNEL_DISABLED", "Turn the channel on before testing it");
  }
  const delivery = await createTestDelivery(channel);
  await enqueueDeliveries([delivery.id]);
  return delivery;
}

// The test button sends real SMS/emails, so it's limited per channel
const testRateLimit = {
  max: 5,
  timeWindow: "10 minutes",
  keyGenerator: (request: FastifyRequest) =>
    `notification-test:${(request.params as ChannelParams).channelId}`,
};

const recentDeliveries = () =>
  db
    .select({
      id: notificationLog.id,
      channelId: notificationLog.channelId,
      channelType: notificationLog.channelType,
      recipient: notificationLog.recipient,
      trigger: notificationLog.trigger,
      status: notificationLog.status,
      attempts: notificationLog.attempts,
      error: notificationLog.error,
      createdAt: notificationLog.createdAt,
      sentAt: notificationLog.sentAt,
      incident: { id: incidents.id, title: incidents.title, projectId: incidents.projectId },
    })
    .from(notificationLog)
    .leftJoin(incidents, eq(incidents.id, notificationLog.incidentId))
    .orderBy(desc(notificationLog.createdAt))
    .limit(50)
    .$dynamic();

export async function notificationRoutes(app: FastifyInstance) {
  // ---------- Your contact methods and preferences ----------

  app.get("/me/notification-channels", { preHandler: requireAuth }, async (request) => {
    const channels = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.userId, request.user.id))
      .orderBy(notificationChannels.createdAt);

    const notifiers = defaultNotifiers();
    return {
      channels: channels.map(toPublic),
      // What this server can send, so the page can hide what won't work
      available: {
        email: notifiers.email.isConfigured(),
        sms: notifiers.sms.isConfigured(),
        push: notifiers.push.isConfigured(),
      },
      pushPublicKey: config.VAPID_PUBLIC_KEY ?? null,
    };
  });

  app.post("/me/notification-channels", { preHandler: requireAuth }, async (request, reply) => {
    const body = parse(CreateUserChannelSchema, request.body);
    const userId = request.user.id;

    // The same browser subscribing again: refresh it instead of adding a duplicate
    if (body.type === "push") {
      const [existing] = await db
        .update(notificationChannels)
        .set({ config: body.config, enabled: true, updatedAt: new Date() })
        .where(
          and(
            eq(notificationChannels.userId, userId),
            eq(notificationChannels.type, "push"),
            sql`${notificationChannels.config}->>'endpoint' = ${body.config.endpoint}`,
          ),
        )
        .returning();
      if (existing) return reply.code(200).send({ channel: toPublic(existing) });
    }

    await checkLimit({ userId });
    const [channel] = await db
      .insert(notificationChannels)
      .values({
        userId,
        type: body.type,
        name: body.name ?? defaultName(body.config),
        config: body.config,
        minSeverity: body.minSeverity,
      })
      .returning();
    if (!channel) throw new Error("channel not created");
    return reply.code(201).send({ channel: toPublic(channel) });
  });

  app.patch<{ Params: ChannelParams }>(
    "/me/notification-channels/:channelId",
    { preHandler: requireAuth },
    async (request) => {
      const channel = await findChannel({ userId: request.user.id }, request.params.channelId);
      return { channel: await updateChannel(channel, request.body) };
    },
  );

  // Its delivery log rows stay (channel_id becomes null): history isn't deleted
  app.delete<{ Params: ChannelParams }>(
    "/me/notification-channels/:channelId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const channel = await findChannel({ userId: request.user.id }, request.params.channelId);
      await db.delete(notificationChannels).where(eq(notificationChannels.id, channel.id));
      return reply.code(204).send();
    },
  );

  app.post<{ Params: ChannelParams }>(
    "/me/notification-channels/:channelId/test",
    { preHandler: requireAuth, config: { rateLimit: testRateLimit } },
    async (request, reply) => {
      const channel = await findChannel({ userId: request.user.id }, request.params.channelId);
      return reply.code(202).send({ delivery: await sendTest(channel) });
    },
  );

  // What was sent to you lately
  app.get("/me/notifications", { preHandler: requireAuth }, async (request) => {
    const deliveries = await recentDeliveries()
      .innerJoin(notificationChannels, eq(notificationChannels.id, notificationLog.channelId))
      .where(eq(notificationChannels.userId, request.user.id));
    return { deliveries };
  });

  // ---------- The organization's team channels ----------

  app.get<{ Params: OrgParams }>(
    "/orgs/:orgId/notification-channels",
    { preHandler: [requireAuth, requireOrgRole("member")] },
    async (request) => {
      const channels = await db
        .select()
        .from(notificationChannels)
        .where(eq(notificationChannels.orgId, request.membership.orgId))
        .orderBy(notificationChannels.createdAt);
      return { channels: channels.map(toPublic) };
    },
  );

  app.post<{ Params: OrgParams }>(
    "/orgs/:orgId/notification-channels",
    { preHandler: [requireAuth, requireOrgRole("admin")] },
    async (request, reply) => {
      const body = parse(CreateOrgChannelSchema, request.body);
      const orgId = request.membership.orgId;
      await checkLimit({ orgId });

      const channelConfig =
        body.type === "webhook"
          ? { url: body.config.url, secret: newWebhookSecret() }
          : body.config;
      const secret = "secret" in channelConfig ? channelConfig.secret : null;

      const [channel] = await db
        .insert(notificationChannels)
        .values({
          orgId,
          type: body.type,
          name: body.name ?? defaultName(channelConfig),
          config: channelConfig,
          minSeverity: body.minSeverity,
        })
        .returning();
      if (!channel) throw new Error("channel not created");
      await audit(request, {
        orgId,
        action: "channel.created",
        targetType: "notification_channel",
        targetId: channel.id,
        data: { type: channel.type, name: channel.name },
      });
      // The only time the secret is shown: the receiver needs it to check signatures
      return reply.code(201).send({ channel: toPublic(channel), secret });
    },
  );

  app.patch<{ Params: OrgChannelParams }>(
    "/orgs/:orgId/notification-channels/:channelId",
    { preHandler: [requireAuth, requireOrgRole("admin")] },
    async (request) => {
      const orgId = request.membership.orgId;
      const channel = await findChannel({ orgId }, request.params.channelId);
      const updated = await updateChannel(channel, request.body);
      await audit(request, {
        orgId,
        action: "channel.updated",
        targetType: "notification_channel",
        targetId: channel.id,
        data: { type: channel.type, name: channel.name, ...changedFields(request.body ?? {}) },
      });
      return { channel: updated };
    },
  );

  app.delete<{ Params: OrgChannelParams }>(
    "/orgs/:orgId/notification-channels/:channelId",
    { preHandler: [requireAuth, requireOrgRole("admin")] },
    async (request, reply) => {
      const channel = await findChannel(
        { orgId: request.membership.orgId },
        request.params.channelId,
      );
      await db.delete(notificationChannels).where(eq(notificationChannels.id, channel.id));
      await audit(request, {
        orgId: request.membership.orgId,
        action: "channel.deleted",
        targetType: "notification_channel",
        targetId: channel.id,
        data: { type: channel.type, name: channel.name },
      });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: OrgChannelParams }>(
    "/orgs/:orgId/notification-channels/:channelId/test",
    {
      preHandler: [requireAuth, requireOrgRole("admin")],
      config: { rateLimit: testRateLimit },
    },
    async (request, reply) => {
      const channel = await findChannel(
        { orgId: request.membership.orgId },
        request.params.channelId,
      );
      return reply.code(202).send({ delivery: await sendTest(channel) });
    },
  );

  // The delivery log: every notification Pulse sent for this org's incidents
  app.get<{ Params: OrgParams }>(
    "/orgs/:orgId/notifications",
    { preHandler: [requireAuth, requireOrgRole("member")] },
    async (request) => {
      const deliveries = await recentDeliveries().where(
        eq(notificationLog.orgId, request.membership.orgId),
      );
      return { deliveries };
    },
  );
}
