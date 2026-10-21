import { parseDsn } from "./dsn.js";
import { parseStack } from "./stacktrace.js";
import { createFetchTransport } from "./transport.js";
import type { CaptureContext, Level, PulseEvent, PulseOptions, Transport, User } from "./types.js";

export const SDK_NAME = "@pulse/sdk";
export const SDK_VERSION = "0.1.0";

const MAX_MESSAGE = 10_000;
const MAX_TAG_VALUE = 200;

// 32 hex characters, the event_id format the API expects
function newEventId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().replaceAll("-", "");
  }
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

const truncate = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

// Anything can be thrown in JS: Errors, strings, objects...
function exceptionFrom(error: unknown): NonNullable<PulseEvent["exception"]> {
  if (error instanceof Error) {
    const frames = parseStack(error.stack);
    return {
      type: error.name || "Error",
      value: truncate(error.message, MAX_MESSAGE),
      stacktrace: frames.length > 0 ? { frames } : undefined,
    };
  }
  const value = typeof error === "string" ? error : safeStringify(error);
  return { type: "Error", value: truncate(value, MAX_MESSAGE) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export class PulseClient {
  private readonly options: PulseOptions;
  private readonly transport: Transport;
  private readonly pending = new Set<Promise<void>>();

  // The "scope": data attached to every event from now on
  private user: User | undefined;
  private readonly tags: Record<string, string> = {};
  private readonly context: Record<string, unknown> = {};

  constructor(options: PulseOptions) {
    this.options = options;
    this.transport = options.transport ?? createFetchTransport(parseDsn(options.dsn));
  }

  setUser(user: User | null) {
    this.user = user ?? undefined;
  }

  setTag(key: string, value: string) {
    this.tags[key] = truncate(String(value), MAX_TAG_VALUE);
  }

  setContext(key: string, value: unknown) {
    this.context[key] = value;
  }

  captureException(error: unknown, extra: CaptureContext = {}): string | undefined {
    return this.capture({ exception: exceptionFrom(error) }, extra, error);
  }

  captureMessage(message: string, level: Level = "info", extra: CaptureContext = {}) {
    return this.capture({ message: truncate(message, MAX_MESSAGE) }, { level, ...extra });
  }

  // Waits for events still being sent, at most `timeoutMs`. Call before the process exits.
  async flush(timeoutMs = 2_000): Promise<boolean> {
    const done = Promise.allSettled([...this.pending]).then(() => true);
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs));
    return Promise.race([done, timeout]);
  }

  private capture(
    body: Pick<PulseEvent, "exception" | "message">,
    extra: CaptureContext,
    originalError?: unknown,
  ): string | undefined {
    const { enabled = true, sampleRate = 1, beforeSend } = this.options;
    if (!enabled || Math.random() >= sampleRate) return undefined;

    let event: PulseEvent | null = {
      event_id: newEventId(),
      timestamp: new Date().toISOString(),
      level: extra.level ?? "error",
      ...body,
      environment: this.options.environment ?? "production",
      release: this.options.release,
      user: extra.user ?? this.user,
      request: extra.request,
      tags: this.merge(this.tags, extra.tags),
      context: this.merge(this.context, extra.context),
      fingerprint: extra.fingerprint,
      sdk: { name: SDK_NAME, version: SDK_VERSION },
    };

    if (beforeSend) {
      try {
        event = beforeSend(event, { originalError });
      } catch (err) {
        console.error("Pulse: beforeSend threw, sending the event unchanged", err);
      }
    }
    if (!event) return undefined;

    this.send(event);
    return event.event_id;
  }

  private merge<T>(base: Record<string, T>, extra?: Record<string, T>) {
    const merged = { ...base, ...extra };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  // Fire and forget: the app never waits for Pulse, and a Pulse outage never throws into it
  private send(event: PulseEvent) {
    const promise = this.transport(event)
      .catch((err: unknown) => {
        console.error("Pulse: could not send event", err instanceof Error ? err.message : err);
      })
      .finally(() => this.pending.delete(promise));
    this.pending.add(promise);
  }
}
