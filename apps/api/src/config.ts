import { z } from "zod";

// The shape our settings MUST have.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  // Where SDKs can reach this API from outside; used to build project DSNs
  API_PUBLIC_URL: z.url().default("http://localhost:3000"),
});

// Check the real environment variables against the schema.
const result = EnvSchema.safeParse(process.env);

if (!result.success) {
  console.error("❌ Invalid environment variables:\n" + z.prettifyError(result.error));
  process.exit(1);
}

export const config = result.data;
export type Config = typeof config;
