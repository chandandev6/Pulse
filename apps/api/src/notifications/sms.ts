import { config } from "../config.js";
import { type Notifier, PermanentError } from "./notifier.js";

const TWILIO_API = "https://api.twilio.com/2010-04-01";

// SMS through Twilio's REST API (one HTTP request, so no SDK needed).
// Without TWILIO_* settings it's off: SMS deliveries are logged as "skipped".
export function createSmsNotifier(settings = config): Notifier<"sms"> {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = settings;

  return {
    isConfigured: () => Boolean(sid && token && from),
    async send({ phone }, message) {
      if (!sid || !token || !from) throw new PermanentError("SMS is not configured");

      const res = await fetch(`${TWILIO_API}/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: phone, From: from, Body: message.short }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;

      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      const error = `Twilio answered ${res.status}: ${data?.message ?? res.statusText}`;
      // 4xx = bad number, unverified number, bad credentials: retrying won't fix it
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new PermanentError(error);
      }
      throw new Error(error);
    },
  };
}
