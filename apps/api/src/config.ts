import { z } from "zod";

const DEV_SECRET = "dev-only-secret-change-me-in-production-please";

// Optional settings: unset and "" both mean "not configured"
const optional = z
  .string()
  .optional()
  .transform((value) => value || undefined);

// TRUST_PROXY: "1" → trust 1 hop, "true"/"false" → all/none, anything else → proxy IPs/CIDRs
export function parseTrustProxy(value: string): boolean | number | string {
  if (value === "true") return true;
  if (value === "false" || value === "") return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

// Optional numbers: unset and "" (what docker compose passes for an empty variable) = not set
const optionalNumber = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().int().positive().optional(),
);

// The shape our settings MUST have.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(3000),
  // How many reverse proxies in front of the API to trust (see app.ts). "1" = nginx only.
  // Also accepts proxy IPs/CIDRs ("10.0.0.0/8"). "true" trusts every hop: avoid it,
  // because then any client can pick its own IP with an X-Forwarded-For header.
  TRUST_PROXY: z.string().default("false").transform(parseTrustProxy),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  // Where SDKs can reach this API from outside; used to build project DSNs
  API_PUBLIC_URL: z.url().default("http://localhost:3000"),
  // Where people open the dashboard; used for links in notifications
  WEB_PUBLIC_URL: z.url().default("http://localhost:5173"),
  // Signs links in notifications (e.g. "acknowledge"). Must be secret in production.
  APP_SECRET: z.string().min(32).default(DEV_SECRET),

  // New accounts must click the link in a verification email before they can create
  // projects, add notification channels or invite people. Turn on when email works.
  REQUIRE_EMAIL_VERIFICATION: z.stringbool().default(false),

  // Ceilings for what an org admin can set on their own project. On a server where strangers
  // can sign up, set them, or one free account can fill your database. Unset = no ceiling.
  MAX_EVENTS_PER_MINUTE: optionalNumber,
  // Also replaces "no quota" on every project
  MAX_MONTHLY_QUOTA: optionalNumber,
  // Source maps stored per project (all releases together), in megabytes
  MAX_SOURCE_MAP_MB: z.coerce.number().int().positive().default(200),

  // Pulse reporting its own errors to a Pulse project (yes, possibly itself).
  // The DSN from that project's Settings page; unset = off.
  PULSE_DSN: optional,
  PULSE_RELEASE: optional, // e.g. the git commit being deployed

  // Email (F11). Defaults point at Mailpit from docker-compose.yml
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: z.stringbool().default(false), // true = TLS from the start (port 465)
  SMTP_USER: optional,
  SMTP_PASS: optional,
  SMTP_FROM: z.string().default("Pulse <alerts@pulse.local>"),

  // SMS through Twilio: off unless all three are set
  TWILIO_ACCOUNT_SID: optional,
  TWILIO_AUTH_TOKEN: optional,
  TWILIO_FROM: optional,

  // Browser push (Web Push): off unless both keys are set.
  // Make a pair with: pnpm --filter @pulse/api exec web-push generate-vapid-keys
  VAPID_PUBLIC_KEY: optional,
  VAPID_PRIVATE_KEY: optional,
  VAPID_SUBJECT: z.string().default("mailto:alerts@pulse.local"),

  // Webhooks may only call public addresses (SSRF protection). Set true if your receivers
  // live on your own network (e.g. http://10.0.0.5/hook), and only if you trust every admin.
  ALLOW_PRIVATE_WEBHOOKS: z.stringbool().default(false),
});

// Check the real environment variables against the schema.
const result = EnvSchema.safeParse(process.env);

if (!result.success) {
  console.error(`❌ Invalid environment variables:\n${z.prettifyError(result.error)}`);
  process.exit(1);
}

if (result.data.NODE_ENV === "production" && result.data.APP_SECRET === DEV_SECRET) {
  console.error("❌ Set APP_SECRET to a long random value in production");
  process.exit(1);
}

export const config = result.data;
export type Config = typeof config;
