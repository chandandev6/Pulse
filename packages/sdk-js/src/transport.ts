import type { ParsedDsn } from "./dsn.js";
import type { PulseEvent, Transport } from "./types.js";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1_000;
// Browsers only let small requests use keepalive (they survive the page closing)
const KEEPALIVE_LIMIT = 60_000;

class RetryableError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Sends with fetch. Retries network errors, 429 and 5xx with backoff (1s, 2s),
// but not other 4xx: a bad key or bad payload won't get better by retrying.
export function createFetchTransport(dsn: ParsedDsn, fetchImpl: typeof fetch = fetch): Transport {
  return async (event: PulseEvent) => {
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
        if (res.status !== 429 && res.status < 500) {
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
