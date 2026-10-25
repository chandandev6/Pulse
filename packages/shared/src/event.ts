import { z } from "zod";

// The shape of an error report. The API checks incoming events against it,
// and the SDK (F5) uses the same schema, so both sides always agree.

export const LEVELS = ["fatal", "error", "warning", "info", "debug"] as const;

const short = z.string().max(200);
const text = z.string().max(10_000);

const FrameLocation = z.object({
  filename: z.string().max(1_000).optional(),
  function: short.optional(),
  lineno: z.number().int().nonnegative().optional(),
  colno: z.number().int().nonnegative().optional(),
});

export const StackFrameSchema = FrameLocation.extend({
  // false for code inside node_modules or the browser itself
  in_app: z.boolean().optional(),
  // Set by the server when a source map translated this frame: where it was in the
  // minified file the browser actually ran
  minified: FrameLocation.optional(),
});

export const ExceptionSchema = z.object({
  type: short, // "TypeError"
  value: text.optional(), // "Cannot read properties of undefined"
  stacktrace: z.object({ frames: z.array(StackFrameSchema).max(250) }).optional(),
});

export const EventUserSchema = z.object({
  id: short.optional(),
  email: short.optional(),
  username: short.optional(),
  ip: short.optional(),
});

export const EventRequestSchema = z.object({
  method: z.string().max(20).optional(),
  url: z.string().max(2_000).optional(),
  route: short.optional(), // "/users/:id", the pattern rather than the real URL
  headers: z.record(z.string(), z.string().max(2_000)).optional(),
});

export const EventSchema = z
  .object({
    // 32 hex characters, made by the SDK so retries of the same event can be spotted
    event_id: z
      .string()
      .regex(/^[a-f0-9]{32}$/, "Must be 32 lowercase hex characters")
      .default(() => crypto.randomUUID().replaceAll("-", "")),
    timestamp: z.iso.datetime({ offset: true }).default(() => new Date().toISOString()),
    level: z.enum(LEVELS).default("error"),
    message: text.optional(),
    exception: ExceptionSchema.optional(),
    environment: z.string().trim().min(1).max(64).default("production"),
    release: short.optional(),
    user: EventUserSchema.optional(),
    request: EventRequestSchema.optional(),
    tags: z.record(z.string().max(64), z.string().max(200)).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
    sdk: z.object({ name: short, version: short }).optional(),
    // Optional: the app decides grouping itself. Events with the same list become one issue.
    fingerprint: z.array(short).min(1).max(10).optional(),
  })
  .refine((event) => event.message || event.exception, {
    message: "An event needs a message or an exception",
  });

// What the SDK sends (defaults may be missing) vs. what the API works with (defaults filled in)
export type EventInput = z.input<typeof EventSchema>;
export type PulseEvent = z.output<typeof EventSchema>;
export type StackFrame = z.infer<typeof StackFrameSchema>;
