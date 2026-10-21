import { defineConfig } from "@playwright/test";

// End-to-end: the real API, worker, database and dashboard, driven in a real Chrome.
// Needs Docker (Postgres + Redis) running. Uses its own ports so `pnpm dev` can keep running.
const API_PORT = 3098;
const WEB_PORT = 5198;
const API_URL = `http://localhost:${API_PORT}`;

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    channel: "chrome", // the Chrome already installed on this machine
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // API and event worker together: the worker has no URL of its own to wait for
      command: 'pnpm --filter @pulse/api run --parallel "/^(dev|worker)$/"',
      url: `${API_URL}/health`,
      env: { API_PORT: String(API_PORT), API_PUBLIC_URL: API_URL },
      reuseExistingServer: false,
    },
    {
      command: `pnpm exec vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { PULSE_API_URL: API_URL },
      reuseExistingServer: false,
    },
  ],
});
