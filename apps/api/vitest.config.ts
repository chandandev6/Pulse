import { defineConfig } from "vitest/config";

process.loadEnvFile("../../.env");

export default defineConfig({
  test: {
    env: { NODE_ENV: "test" },
  },
});
