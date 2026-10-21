import type { EventInput } from "@pulse/shared";

export type PulseEvent = EventInput;
export type Level = NonNullable<EventInput["level"]>;
export type User = NonNullable<EventInput["user"]>;
export type RequestInfo = NonNullable<EventInput["request"]>;

// What you can attach to one captured error, on top of the global scope
export type CaptureContext = {
  level?: Level;
  user?: User;
  tags?: Record<string, string>;
  context?: Record<string, unknown>;
  request?: RequestInfo;
  fingerprint?: string[];
};

// Sends one event. Swappable so tests (and unusual runtimes) can replace fetch.
export type Transport = (event: PulseEvent) => Promise<void>;

export type PulseOptions = {
  dsn: string;
  environment?: string; // default "production"
  release?: string; // e.g. "1.4.2" or a git commit
  // 0 to 1: the share of events to send. 0.25 keeps 1 in 4, to save quota on busy apps.
  sampleRate?: number;
  // Last chance to edit or drop (return null) an event, e.g. to remove private data
  beforeSend?: (event: PulseEvent, hint: { originalError?: unknown }) => PulseEvent | null;
  // Catch errors nobody caught (uncaughtException, window.onerror, ...). Default true.
  captureUnhandled?: boolean;
  // Turn the SDK off, e.g. in local development. Default true.
  enabled?: boolean;
  // Advanced: replace how events are sent
  transport?: Transport;
};
