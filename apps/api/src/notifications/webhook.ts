import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { type Notifier, PermanentError } from "./notifier.js";

const TIMEOUT_MS = 10_000;
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

// Shown once when the webhook is created; the receiver keeps it to check signatures
export const newWebhookSecret = () => `whsec_${randomBytes(24).toString("base64url")}`;

// HMAC = a hash of the body mixed with a secret only we and the receiver know.
// The receiver recomputes it: if it matches, the request really came from Pulse
// and nobody changed the body on the way. The timestamp is signed too, so an
// old request captured by someone can't be replayed much later.
export const signWebhook = (secret: string, timestamp: number, body: string) =>
  `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

// What a receiver does (exported for tests and as an example for our users)
export function verifyWebhookSignature(
  secret: string,
  headers: { timestamp: string | undefined; signature: string | undefined },
  body: string,
  now = Date.now(),
) {
  const timestamp = Number(headers.timestamp);
  if (!Number.isInteger(timestamp) || !headers.signature) return false;
  if (Math.abs(now / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const given = Buffer.from(headers.signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// These mean "your request is wrong": sending the same one again won't help.
// 408 (timeout) and 429 (slow down) are worth retrying.
const isPermanent = (status: number) =>
  status >= 400 && status < 500 && ![408, 429].includes(status);

export function createWebhookNotifier(): Notifier<"webhook"> {
  return {
    isConfigured: () => true,
    async send({ url, secret }, message) {
      const body = JSON.stringify(message.payload);
      const timestamp = Math.floor(Date.now() / 1000);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Pulse-Webhooks/1.0",
          "x-pulse-delivery": message.deliveryId,
          "x-pulse-timestamp": String(timestamp),
          "x-pulse-signature": signWebhook(secret, timestamp, body),
        },
        body,
        redirect: "manual", // a redirect could send our signed payload somewhere else
        signal: AbortSignal.timeout(TIMEOUT_MS), // a hanging server must not block the worker
      });
      await res.body?.cancel(); // we don't need their answer, only the status

      if (res.ok) return;
      const error = `Webhook answered ${res.status} ${res.statusText}`.trim();
      if (isPermanent(res.status)) throw new PermanentError(error);
      throw new Error(error); // 5xx, 408, 429, 3xx: retried
    },
  };
}
