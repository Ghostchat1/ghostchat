// Caches the app shell so Raazdar opens instantly and works as an installed app.
const CACHE = "raazdar-v6.9";
const SHELL = ["/app", "/app.js", "/style.css", "/icon.svg", "/manifest.webmanifest", "/pq.js", "/qr.js", "/icon-180.png", "/icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.pathname.startsWith("/api/") || u.pathname === "/ws" || u.pathname === "/wipe") return;
  // network first, fall back to cache when offline
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match("/app"))));
});

// Content-free wake-up: the push carries nothing. Show a neutral notice (iOS requires one for every push).
self.addEventListener("push", (e) => {
  e.waitUntil(self.registration.showNotification("New activity", { body: "", tag: "gc", renotify: true, icon: "/icon-192.png", badge: "/icon-192.png", silent: false }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if (new URL(c.url).pathname.startsWith("/app")) return c.focus();
    return self.clients.openWindow("/app");
  }));
});
