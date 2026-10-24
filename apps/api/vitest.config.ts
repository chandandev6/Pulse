import { defineConfig } from "vitest/config";

// Locally from the repo's .env; in CI the workflow sets the variables itself
try {
  process.loadEnvFile("../../.env");
} catch {
  // no .env file: fine
}

export default defineConfig({
  test: {
    env: { NODE_ENV: "test" },
  },
});
