import { config } from "../config.js";
import type { IncidentStatus, Severity } from "../db/schema.js";
import { ackUrl, issueUrl } from "./links.js";

// Everything a notification says about an incident (loaded once per delivery)
export type IncidentDetails = {
  incident: {
    id: string;
    title: string;
    severity: Severity;
    status: IncidentStatus;
    triggeredAt: Date;
    escalationPolicyId: string | null;
    escalationStep: number;
  };
  issue: {
    id: string;
    title: string;
    culprit: string | null;
    eventCount: number;
    userCount: number;
    firstSeen: Date;
    lastSeen: Date;
    lastRelease: string | null;
  };
  project: { id: string; name: string };
  org: { id: string; name: string };
  rule: { id: string; name: string } | null;
};

// The JSON body webhooks receive. Its shape is a promise to other people's code:
// add fields freely, but don't rename or remove them.
export type WebhookPayload = {
  type: "incident.triggered" | "incident.escalated" | "test";
  deliveryId: string;
  sentAt: string;
  incident?: {
    id: string;
    title: string;
    severity: Severity;
    status: IncidentStatus;
    triggeredAt: string;
  };
  issue?: {
    id: string;
    title: string;
    culprit: string | null;
    eventCount: number;
    userCount: number;
    firstSeen: string;
    lastSeen: string;
    release: string | null;
  };
  project?: { id: string; name: string };
  organization?: { id: string; name: string };
  rule?: { id: string; name: string } | null;
  links?: { issue: string; acknowledge: string };
  message?: string;
};

// One message, in every form a channel might need
export type NotificationMessage = {
  deliveryId: string; // the notification_log row, also sent to webhooks as X-Pulse-Delivery
  subject: string; // email subject, push title
  text: string; // plain-text email
  html: string; // HTML email
  short: string; // SMS and push body: one or two lines
  url: string; // where a click should go
  payload: WebhookPayload;
};

// Anything that came from an app (titles, culprits...) could contain "<script>".
// In HTML we escape it, so it shows up as text instead of running.
export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const SEVERITY_COLOR: Record<Severity, string> = {
  low: "#64748b",
  medium: "#ca8a04",
  high: "#ea580c",
  critical: "#dc2626",
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// SMS messages are billed per 160 characters, so keep them short
const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

// recipientUserId: who gets this copy, so their acknowledge link says who clicked it.
// escalated: nobody acknowledged in time, so this goes to the next level (F14).
export function incidentMessage(
  details: IncidentDetails,
  deliveryId: string,
  recipientUserId: string | null,
  { escalated = false, now = new Date() }: { escalated?: boolean; now?: Date } = {},
): NotificationMessage {
  const { incident, issue, project, org, rule } = details;
  const links = {
    issue: issueUrl(project.id, issue.id),
    acknowledge: ackUrl(incident.id, recipientUserId),
  };
  const severity = incident.severity.toUpperCase();
  const impact = `${plural(issue.eventCount, "event")}, ${plural(issue.userCount, "user")} affected`;

  const facts: [string, string][] = [
    ["Project", project.name],
    ["Severity", incident.severity],
    ["Events", String(issue.eventCount)],
    ["Users affected", String(issue.userCount)],
    ["Where", issue.culprit ?? "unknown"],
    ["Release", issue.lastRelease ?? "unknown"],
    ["First seen", issue.firstSeen.toISOString()],
    ["Last seen", issue.lastSeen.toISOString()],
    ["Alert rule", rule?.name ?? "deleted rule"],
  ];

  const why = escalated
    ? "You get this because nobody acknowledged it in time and you're next on the escalation policy."
    : `You get this because you're a member of ${org.name} on Pulse.`;

  const text = [
    `[${severity}] ${incident.title}`,
    ...(escalated ? ["", "ESCALATED: nobody has acknowledged this yet."] : []),
    "",
    ...facts.map(([label, value]) => `${label}: ${value}`),
    "",
    `Investigate: ${links.issue}`,
    `Acknowledge: ${links.acknowledge}`,
    "",
    why,
  ].join("\n");

  const rows = facts
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#64748b">${escapeHtml(label)}</td><td style="padding:4px 0">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  const html = `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;color:#0f172a;max-width:600px">
<p style="margin:0 0 8px"><span style="background:${SEVERITY_COLOR[incident.severity]};color:#fff;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:600">${severity}</span> ${escapeHtml(project.name)}</p>
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(incident.title)}</h1>
${escalated ? '<p style="color:#dc2626;font-weight:600;margin:0 0 16px">Escalated: nobody has acknowledged this yet.</p>' : ""}
<table style="border-collapse:collapse;font-size:14px;margin-bottom:20px">${rows}</table>
<p>
<a href="${escapeHtml(links.acknowledge)}" style="background:#0f172a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;margin-right:8px">Acknowledge</a>
<a href="${escapeHtml(links.issue)}" style="color:#2563eb">Investigate in Pulse →</a>
</p>
<p style="color:#64748b;font-size:12px;margin-top:24px">${escapeHtml(why)}</p>
</body></html>`;

  return {
    deliveryId,
    subject: `[${severity}]${escalated ? " ESCALATED" : ""} ${project.name}: ${incident.title}`,
    text,
    html,
    short: truncate(
      `Pulse ${severity}${escalated ? " ESCALATED" : ""} · ${project.name}: ${incident.title} (${impact})`,
      300,
    ),
    url: links.issue,
    payload: {
      type: escalated ? "incident.escalated" : "incident.triggered",
      deliveryId,
      sentAt: now.toISOString(),
      incident: {
        id: incident.id,
        title: incident.title,
        severity: incident.severity,
        status: incident.status,
        triggeredAt: incident.triggeredAt.toISOString(),
      },
      issue: {
        id: issue.id,
        title: issue.title,
        culprit: issue.culprit,
        eventCount: issue.eventCount,
        userCount: issue.userCount,
        firstSeen: issue.firstSeen.toISOString(),
        lastSeen: issue.lastSeen.toISOString(),
        release: issue.lastRelease,
      },
      project,
      organization: org,
      rule,
      links,
    },
  };
}

// The "Send test" button: proves the channel works without a real incident
export function testMessage(deliveryId: string, channelName: string, now = new Date()) {
  const line = `This is a test notification from Pulse for "${channelName}". If you can read it, this channel works.`;
  return {
    deliveryId,
    subject: "Pulse test notification",
    text: line,
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif"><p>${escapeHtml(line)}</p></body></html>`,
    short: truncate(line, 300),
    url: config.WEB_PUBLIC_URL,
    payload: { type: "test", deliveryId, sentAt: now.toISOString(), message: line },
  } satisfies NotificationMessage;
}
