import { Agent } from "node:https";
import webpush from "web-push";
import { config } from "../config.js";
import { type Notifier, PermanentError } from "./notifier.js";
import { assertPublicIpHost, publicOnlyLookup } from "./ssrf.js";

// The subscription's endpoint comes from the browser, so a user could send any URL.
// Real push services are public: refuse anything that resolves to a private address.
const publicOnly = new Agent({ lookup: publicOnlyLookup });

// Web Push: the browser gave us a "subscription" (an address at Google's, Mozilla's
// or Apple's push service). We send an encrypted message there, and it wakes up
// the dashboard's service worker (apps/web/public/sw.js), which shows the notification.
// VAPID keys prove to the push service that the message comes from us.
export function createPushNotifier(settings = config): Notifier<"push"> {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = settings;
  const vapidDetails =
    publicKey && privateKey ? { subject: settings.VAPID_SUBJECT, publicKey, privateKey } : null;

  return {
    isConfigured: () => vapidDetails !== null,
    async send(subscription, message) {
      if (!vapidDetails) throw new PermanentError("Push is not configured");
      assertPublicIpHost(subscription.endpoint);

      try {
        await webpush.sendNotification(
          subscription,
          JSON.stringify({ title: message.subject, body: message.short, url: message.url }),
          { vapidDetails, TTL: 60 * 60, urgency: "high", timeout: 10_000, agent: publicOnly },
        );
      } catch (err) {
        // 404/410: the user unsubscribed or cleared the browser, the address is dead
        if (err instanceof webpush.WebPushError && [404, 410].includes(err.statusCode)) {
          throw new PermanentError("The browser subscription has expired", {
            disableChannel: true,
          });
        }
        throw err;
      }
    },
  };
}
