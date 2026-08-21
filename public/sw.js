// public/sw.js
//
// Minimal service worker — just enough to receive and show push
// notifications when a task finishes. No offline caching, nothing fancy.

self.addEventListener("push", (event) => {
  let data = { title: "MKDAI", body: "A task finished." };
  try {
    if (event.data) data = event.data.json();
  } catch {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "MKDAI", {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/"));
});
