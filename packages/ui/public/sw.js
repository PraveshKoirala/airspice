/*
 * AirSpice service worker (Milestone M6, issue #31).
 *
 * Makes the app genuinely offline-capable — not just a manifest shell. Strategy:
 *   - App shell ('/') is precached on install so a cold offline load still boots.
 *   - Same-origin static assets (hashed JS/CSS, the ~20 MB ngspice WASM chunk,
 *     workers, icons) are cached cache-first on first fetch, so a second visit —
 *     online or offline — serves them instantly from the Cache Storage.
 *   - Navigations are network-first with an offline fallback to the cached shell,
 *     so the SPA loads with no network.
 *   - Cross-origin requests (Google Fonts, BYOK provider APIs) always pass
 *     through to the network and are never cached (opaque + privacy).
 *
 * Bump CACHE when the shell contract changes; activate() purges older caches.
 */
const CACHE = "airspice-v1";
const SHELL = ["/", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Precache the shell; tolerate a missing optional entry rather than failing
      // the whole install.
      await Promise.all(
        SHELL.map((url) => cache.add(url).catch(() => undefined)),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // cross-origin -> network only

  if (request.mode === "navigate") {
    // Network-first for HTML navigations; fall back to the cached shell offline.
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE);
          cache.put("/", fresh.clone()).catch(() => undefined);
          return fresh;
        } catch {
          const cached = (await caches.match(request)) || (await caches.match("/"));
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  // Cache-first for same-origin static assets.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.status === 200 && fresh.type === "basic") {
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone()).catch(() => undefined);
        }
        return fresh;
      } catch {
        return Response.error();
      }
    })(),
  );
});
