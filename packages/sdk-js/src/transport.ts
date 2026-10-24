import type { ParsedDsn } from "./dsn.js";
import type { PulseEvent, Transport } from "./types.js";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1_000;
// Browsers only let small requests use keepalive (they survive the page closing)
const KEEPALIVE_LIMIT = 60_000;

class RetryableError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Sends with fetch. Retries network errors and 5xx with backoff (1s, 2s),
// but not 4xx: a bad key or bad payload won't get better by retrying.
// 429 means "too many events" (the project's rate limit or monthly quota): the server says
// for how long in Retry-After, and until then events are dropped without being sent,
// so a crashing app doesn't keep hammering a server that already said no.
export function createFetchTransport(dsn: ParsedDsn, fetchImpl: typeof fetch = fetch): Transport {
  let pausedUntil = 0;

  return async (event: PulseEvent) => {
    if (Date.now() < pausedUntil) {
      throw new Error("Pulse is rate limiting this project: event dropped");
    }
    const body = JSON.stringify(event);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetchImpl(dsn.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "x-pulse-key": dsn.publicKey },
          body,
          keepalive: body.length < KEEPALIVE_LIMIT,
        });
        if (res.ok) return;
        if (res.status === 429) {
          const seconds = Number(res.headers.get("retry-after"));
          pausedUntil =
            Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
          throw new Error("Pulse is rate limiting this project: event dropped");
        }
        if (res.status < 500) {
          throw new Error(`Pulse rejected the event: HTTP ${res.status}`);
        }
        throw new RetryableError(`HTTP ${res.status}`);
      } catch (err) {
        const retryable = err instanceof RetryableError || err instanceof TypeError; // TypeError = network
        if (!retryable || attempt === MAX_ATTEMPTS) throw err;
        await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  };
}
