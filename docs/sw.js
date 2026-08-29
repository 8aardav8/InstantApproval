// Service worker -- rewritten 2026-08-29 to fix a real, reported bug.
//
// The original version (2026-08-27) served the app shell CACHE-FIRST,
// forever, from a cache name that never changed. That meant once a
// browser or the installed PWA cached the shell once, it would NEVER see
// a newer index.html/app.js/style.css again on its own -- exactly what
// Aaron hit (site "not updating," worse on the installed PWA, which leans
// on this cache even harder than a regular browser tab).
//
// Fixed by flipping to NETWORK-FIRST for the shell: every load tries the
// real network first and updates the cache with whatever it gets back;
// the cache is only ever used as an offline fallback if the network
// request actually fails. This means updates show immediately whenever
// there's a connection, with offline support as a bonus, not the
// original tradeoff (offline support at the cost of never seeing updates).
const CACHE = "iah-shell-v2"; // bumped so every existing installation's stale v1 cache gets cleared out, not just left behind
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
  // must always hit the network fresh, unaffected by this cache at all.
  const url = event.request.url;
  if (url.includes("/data/properties.json") || url.includes("workers.dev")) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // Keep the cache fresh with whatever the network just returned,
        // so the offline fallback below is never more than one visit stale.
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
