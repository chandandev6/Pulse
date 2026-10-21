import type { PulseEvent } from "@pulse/shared";
import type { Severity } from "../db/schema.js";
import { groupingFrames, normalizeFilename } from "./fingerprint.js";

const MAX_TITLE = 200;

// "TypeError: Cannot read properties of undefined"
export function issueTitle(event: PulseEvent): string {
  const { exception, message } = event;
  const title = exception
    ? exception.value
      ? `${exception.type}: ${exception.value}`
      : exception.type
    : (message ?? "");
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title;
}

// Where it broke: the newest app frame (frames are oldest first, crash last),
// or else the route that was being handled.
export function issueCulprit(event: PulseEvent): string | null {
  const frame = groupingFrames(event).at(-1);
  if (frame) {
    const file = frame.filename ? normalizeFilename(frame.filename) : null;
    if (frame.function && file) return `${frame.function} (${file})`;
    return frame.function ?? file;
  }
  const { request } = event;
  if (request?.route) return request.method ? `${request.method} ${request.route}` : request.route;
  return null;
}

// Starting severity from the event level; people can change it later (F6)
const SEVERITY_BY_LEVEL: Record<PulseEvent["level"], Severity> = {
  fatal: "critical",
  error: "high",
  warning: "medium",
  info: "low",
  debug: "low",
};

export function initialSeverity(event: PulseEvent): Severity {
  return SEVERITY_BY_LEVEL[event.level];
}

// One stable key per affected person, best identifier first
export function userKey(event: PulseEvent): string | null {
  const { user } = event;
  if (user?.id) return `id:${user.id}`;
  if (user?.email) return `email:${user.email.toLowerCase()}`;
  if (user?.ip) return `ip:${user.ip}`;
  return null;
}
