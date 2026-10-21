# @pulse/sdk

Sends errors from Node.js and browser apps to Pulse.

## Setup

```js
import Pulse from "@pulse/sdk";

Pulse.init({
  dsn: "http://<public_key>@localhost:3000/<project_id>", // Pulse → project → keys
  environment: "production", // default "production"
  release: "1.4.2", // which version of your app
  sampleRate: 1, // 0–1, share of events to send
  beforeSend: (event) => event, // edit, or return null to drop
});
```

After `init`, errors nobody catches are reported automatically:
`uncaughtException` / `unhandledRejection` in Node (then the process exits, as Node normally does),
`window.onerror` / `unhandledrejection` in browsers.

## Reporting by hand

```js
try {
  riskyThing();
} catch (err) {
  Pulse.captureException(err, { tags: { feature: "checkout" }, context: { cartId: 7 } });
}

Pulse.captureMessage("Disk 91% full", "warning");
```

## Adding details to every event

```js
Pulse.setUser({ id: "42", email: "ada@example.com" });
Pulse.setTag("region", "eu");
Pulse.setContext("plan", { name: "pro" });
```

## Web frameworks

Both report 5xx errors with the request's method, URL and route (secret headers removed).

```js
// Fastify
await app.register(Pulse.fastifyPlugin, { getUser: (req) => ({ id: req.user?.id }) });

// Express: after your routes
app.use(Pulse.expressErrorHandler({ getUser: (req) => ({ id: req.user?.id }) }));
```

## Before a short script exits

```js
await Pulse.flush(); // waits (up to 2s) for events still being sent
```

## Try it

```bash
PULSE_DSN="<your DSN>" pnpm example   # see examples/node-app
```
