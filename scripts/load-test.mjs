// Load test for ingestion: how many events per second can Pulse accept?
//   PULSE_DSN=http://<key>@localhost:8080/<project-id> pnpm load-test
// Options: DURATION (seconds, default 20), CONNECTIONS (default 50), DISTINCT (default 20)
//
// Raise the project's "Events per minute" first, or most requests get 429 (by design).
// Each event is unique (its own event_id), but there are only DISTINCT different errors,
// so the worker also exercises grouping (many events → few issues), like real traffic.
import autocannon from "autocannon";

const dsn = process.env.PULSE_DSN;
if (!dsn) {
  console.error("Set PULSE_DSN (Settings → Your DSN)");
  process.exit(1);
}

const url = new URL(dsn);
const key = url.username;
const projectId = url.pathname.slice(1);
const target = `${url.protocol}//${url.host}/api/${projectId}/events`;
const distinct = Number(process.env.DISTINCT ?? 20);

let counter = 0;
const body = () => {
  counter += 1;
  return JSON.stringify({
    event_id: crypto.randomUUID().replaceAll("-", ""),
    level: "error",
    environment: "load-test",
    release: "load-1.0.0",
    exception: {
      type: "LoadTestError",
      value: `Synthetic failure #${counter % distinct}`,
      stacktrace: {
        frames: [
          {
            filename: "app.js",
            function: `handler${counter % distinct}`,
            lineno: 10,
            in_app: true,
          },
        ],
      },
    },
    user: { id: String(counter % 500) },
    tags: { source: "autocannon" },
  });
};

const instance = autocannon(
  {
    url: target,
    method: "POST",
    connections: Number(process.env.CONNECTIONS ?? 50),
    duration: Number(process.env.DURATION ?? 20),
    headers: { "content-type": "application/json", "x-pulse-key": key },
    requests: [{ setupRequest: (request) => ({ ...request, body: body() }) }],
  },
  (err, result) => {
    if (err) throw err;
    const accepted = result.statusCodeStats["202"]?.count ?? 0;
    const limited = result.statusCodeStats["429"]?.count ?? 0;
    const other = result.non2xx - limited;
    console.log(`\nAccepted (202): ${accepted}   Rate limited (429): ${limited}`);
    if (other > 0 || result.errors > 0) {
      console.log(`Other failures: ${other} bad statuses, ${result.errors} connection errors`);
      console.log("Status codes:", JSON.stringify(result.statusCodeStats));
      process.exitCode = 1;
    }
    console.log(
      `Average: ${Math.round(result.requests.average)} req/s, p99 latency ${result.latency.p99} ms`,
    );
  },
);
autocannon.track(instance, { renderProgressBar: false });
