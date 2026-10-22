// Pulse's service worker: the browser runs it in the background, even when no
// Pulse tab is open. It only does one job: show incident notifications.

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title ?? "Pulse", {
      body: data.body ?? "",
      data: { url: data.url ?? "/" },
      tag: data.url, // a newer notification for the same issue replaces the old one
      requireInteraction: true, // stays until someone deals with it
    }),
  );
});

// Clicking the notification opens (or focuses) the issue in the dashboard
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((tabs) => {
      const open = tabs.find((tab) => tab.url === url);
      return open ? open.focus() : self.clients.openWindow(url);
    }),
  );
});
