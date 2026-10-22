// Browser push: ask permission, then get a "subscription" (an address at the
// browser's push service) that the API can send notifications to.
// public/sw.js is the service worker that shows them, even when Pulse isn't open.

export const pushSupported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

// VAPID public keys are base64url text; the browser wants raw bytes
function keyBytes(base64url: string) {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4))
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export async function subscribeThisBrowser(publicKey: string) {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifications are blocked for this site. Allow them in the browser settings.");
  }

  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true, // browsers require that every push shows a notification
      applicationServerKey: keyBytes(publicKey),
    }));

  const { endpoint, keys } = subscription.toJSON();
  if (!endpoint || !keys?.p256dh || !keys.auth) throw new Error("The browser gave no subscription");
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}
