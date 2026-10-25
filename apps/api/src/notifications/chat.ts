import type { Severity } from "../db/schema.js";
import type { NotificationMessage } from "./message.js";
import { type Notifier, PermanentError } from "./notifier.js";

const TIMEOUT_MS = 10_000;

const SEVERITY_COLOR: Record<Severity, number> = {
  low: 0x1f5d8c,
  medium: 0xf2b544,
  high: 0xff6a13,
  critical: 0xb4232f,
};

// "Project · critical · 214 events · 38 users"
function summary({ payload }: NotificationMessage) {
  return [
    payload.project?.name,
    payload.incident?.severity,
    payload.issue && `${payload.issue.eventCount} events`,
    payload.issue && `${payload.issue.userCount} users`,
  ]
    .filter(Boolean)
    .join(" · ");
}

// Error titles come from other people's apps. In Slack, "<!channel>" or "<https://evil|click>"
// inside a title would ping everyone or show a fake link, so <, > and & are escaped.
const slackEscape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function slackBody(message: NotificationMessage) {
  const ack = message.payload.links?.acknowledge;
  return {
    text: slackEscape(message.subject), // shown in notifications and by clients without blocks
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*<${message.url}|${slackEscape(message.subject)}>*\n${slackEscape(message.short)}`,
        },
      },
      { type: "context", elements: [{ type: "mrkdwn", text: slackEscape(summary(message)) }] },
      ...(ack
        ? [
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Acknowledge" },
                  url: ack,
                  style: "primary",
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: "Open issue" },
                  url: message.url,
                },
              ],
            },
          ]
        : []),
    ],
  };
}

export function discordBody(message: NotificationMessage) {
  const { payload } = message;
  const ack = payload.links?.acknowledge;
  return {
    // Never ping anyone: an error message containing "@everyone" must stay plain text
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: message.subject.slice(0, 256),
        url: message.url,
        description: [message.short, ack && `[Acknowledge](${ack})`]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 4_000),
        color: SEVERITY_COLOR[payload.incident?.severity ?? "low"],
        footer: { text: summary(message).slice(0, 2_000) || "Pulse" },
        timestamp: payload.sentAt,
      },
    ],
  };
}

// Slack and Discord both: POST JSON to the channel's secret URL
function createChatNotifier<T extends "slack" | "discord">(
  service: string,
  toBody: (message: NotificationMessage) => unknown,
): Notifier<T> {
  return {
    isConfigured: () => true,
    async send({ url }, message) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toBody(message)),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await res.body?.cancel();
      if (res.ok) return;

      const error = `${service} answered ${res.status}`;
      // The webhook was deleted, or the channel archived: it will never work again
      if ([404, 410].includes(res.status)) {
        throw new PermanentError(`${error}: the webhook no longer exists`, {
          disableChannel: true,
        });
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new PermanentError(error);
      }
      throw new Error(error); // 5xx and 429 (slow down): retried
    },
  };
}

export const createSlackNotifier = () => createChatNotifier<"slack">("Slack", slackBody);
export const createDiscordNotifier = () => createChatNotifier<"discord">("Discord", discordBody);
