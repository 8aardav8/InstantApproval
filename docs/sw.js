// Minimal service worker (2026-08-27) -- exists mainly to satisfy
// Chrome/Android's PWA "installable" criteria (manifest + a fetch handler
// is the bar), plus a light app-shell cache so the gate/shell loads
// instantly on repeat visits. Deliberately simple -- no offline support for
// live listing data (data/properties.json is always fetched fresh, matching
// the site's existing "no stale data" principle -- see app.js's loadData()).
const CACHE = "iah-shell-v1";
const SHELL = ["./", "index.html", "css/style.css", "js/app.js", "manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Never intercept the live data feed or the admin/gate Worker -- both
  // must always hit the network fresh.
  const url = event.request.url;
  if (url.includes("/data/properties.json") || url.includes("workers.dev")) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
