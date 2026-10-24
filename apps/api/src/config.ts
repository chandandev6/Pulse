import { z } from "zod";

const DEV_SECRET = "dev-only-secret-change-me-in-production-please";

// Optional settings: unset and "" both mean "not configured"
const optional = z
  .string()
  .optional()
  .transform((value) => value || undefined);

// The shape our settings MUST have.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(3000),
  // true when a reverse proxy sits in front of the API (see app.ts)
  TRUST_PROXY: z.stringbool().default(false),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  // Where SDKs can reach this API from outside; used to build project DSNs
  API_PUBLIC_URL: z.url().default("http://localhost:3000"),
  // Where people open the dashboard; used for links in notifications
  WEB_PUBLIC_URL: z.url().default("http://localhost:5173"),
  // Signs links in notifications (e.g. "acknowledge"). Must be secret in production.
  APP_SECRET: z.string().min(32).default(DEV_SECRET),

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
