import { z } from "zod";

// Where a notification can go. A channel belongs to a user (their contact methods:
// email, phone, browser) or to an organization (a team inbox or a webhook).
export const CHANNEL_TYPES = ["email", "sms", "push", "webhook"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const USER_CHANNEL_TYPES = ["email", "sms", "push"] as const;
export const ORG_CHANNEL_TYPES = ["email", "webhook"] as const;

export const EmailConfig = z.object({ address: z.email().trim().toLowerCase().max(320) });

// E.164: "+" then the country code and number, e.g. +919876543210
export const SmsConfig = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/, "Use the international format, e.g. +919876543210"),
});

// What the browser gives us from pushManager.subscribe()
export const PushConfig = z.object({
  endpoint: z.url().max(2_000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

export const WebhookConfig = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2_000),
  secret: z.string(), // made by the server, never sent by the client
});

export type EmailConfig = z.infer<typeof EmailConfig>;
export type SmsConfig = z.infer<typeof SmsConfig>;
export type PushConfig = z.infer<typeof PushConfig>;
export type WebhookConfig = z.infer<typeof WebhookConfig>;

export type ConfigFor = {
  email: EmailConfig;
  sms: SmsConfig;
  push: PushConfig;
  webhook: WebhookConfig;
};
export type ChannelConfig = ConfigFor[ChannelType];

export const DELIVERY_STATUSES = ["pending", "sent", "failed", "skipped"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

// Why a notification was sent. "escalation_2" = the second escalation step (F14).
export type DeliveryTrigger = "incident_triggered" | "test" | `escalation_${number}`;
export const escalationTrigger = (step: number): DeliveryTrigger => `escalation_${step}`;
