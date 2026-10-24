import { defineConfig } from "drizzle-kit";

// Locally the settings come from the repo's .env; in Docker and CI from real env variables
try {
  process.loadEnvFile("../../.env");
} catch {
  // no .env file: fine
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
});
