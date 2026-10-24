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

## Limits and private data

- **Rate limits and quotas.** Each project has an events-per-minute limit and an optional
  monthly quota (Pulse → Settings → Data & limits). Over the limit Pulse answers `429` with a
  `Retry-After` header. The SDK then drops events until that time has passed, so it never
  hammers the server. Network errors and `5xx` are retried twice (after 1s and 2s).
- **Scrubbing.** Pulse removes passwords, tokens, cookies, `Authorization` headers and card
  numbers from events before it stores them. You can add your own field names or remove IP
  addresses in the project settings. To keep something from ever leaving your app,
  use `beforeSend`:

```js
Pulse.init({
  dsn,
  beforeSend(event) {
    delete event.context?.internalNotes;
    return event;
  },
});
```

## Event format

Any HTTP client can send events. `POST /api/<project_id>/events` with the header
`X-Pulse-Key: <public_key>` and a JSON body; `message` or `exception` is required:

```json
{
  "event_id": "32 lowercase hex characters (optional, makes retries safe)",
  "timestamp": "2026-10-24T10:00:00Z",
  "level": "fatal | error | warning | info | debug",
  "message": "Something broke",
  "exception": {
    "type": "TypeError",
    "value": "x is undefined",
    "stacktrace": { "frames": [{ "filename": "app.js", "function": "checkout", "lineno": 42, "in_app": true }] }
  },
  "environment": "production",
  "release": "1.4.2",
  "user": { "id": "42", "email": "ada@example.com", "ip": "203.0.113.7" },
  "request": { "method": "GET", "url": "https://shop.example.com/cart", "route": "/cart", "headers": {} },
  "tags": { "region": "eu" },
  "context": { "cartId": 7 },
  "fingerprint": ["optional", "custom grouping"]
}
```

Answers: `202` accepted, `400` invalid event, `401` bad key, `413` larger than 200 KB,
`429` rate limited or over quota (see `Retry-After`).

## Try it

```bash
PULSE_DSN="<your DSN>" pnpm example   # see examples/node-app
```
