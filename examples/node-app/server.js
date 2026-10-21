// A small shop API that breaks on purpose, to show the Pulse SDK at work.
//
//   PULSE_DSN="http://<key>@localhost:3000/<project-id>" pnpm example
//
// Then open the routes below and watch the issues appear in Pulse.

import Pulse from "@pulse/sdk";
import Fastify from "fastify";

if (!process.env.PULSE_DSN) {
  console.error("Set PULSE_DSN to your project's DSN (Pulse → project → keys)");
  process.exit(1);
}

// 1. Start Pulse first, so it can catch errors from everything after it
Pulse.init({
  dsn: process.env.PULSE_DSN,
  environment: process.env.NODE_ENV ?? "development",
  release: "example-shop@1.0.0",
  beforeSend(event) {
    // Example: never send email addresses typed into the URL
    if (event.request?.url)
      event.request.url = event.request.url.replace(/email=[^&]+/, "email=[hidden]");
    return event;
  },
});
Pulse.setTag("service", "example-shop");

const app = Fastify({ logger: false });

// 2. Report route errors, with the route and the logged-in user
await app.register(Pulse.fastifyPlugin, {
  getUser: (request) => ({
    id: request.headers["x-user-id"] ?? "demo-user-1",
    email: "demo@example.com",
  }),
});

app.get("/", async () => ({
  routes: {
    "/users/:id/checkout": "throws a TypeError → 500, reported automatically",
    "/handled": "catches an error itself and reports it with extra context",
    "/message": "reports a warning message, no error",
    "/crash": "throws outside any request → reported, then the process exits",
  },
}));

app.get("/users/:id/checkout", async (request) => {
  const cart = undefined;
  return { total: cart.total, user: request.params.id }; // TypeError
});

app.get("/handled", async () => {
  try {
    JSON.parse("{ not json");
  } catch (err) {
    Pulse.captureException(err, { level: "warning", context: { input: "{ not json" } });
  }
  return { ok: true, note: "error was reported, but the request still worked" };
});

app.get("/message", async () => {
  Pulse.captureMessage("Disk 91% full on worker-3", "warning");
  return { ok: true };
});

app.get("/crash", async () => {
  // Nobody catches this: Pulse's uncaughtException handler reports it and exits
  setTimeout(() => {
    throw new Error("Background job exploded");
  }, 10);
  return { ok: true, note: "the process will exit in a moment" };
});

const port = Number(process.env.PORT ?? 4000);
await app.listen({ port });
console.log(`Example shop on http://localhost:${port}`);
