// PWA offline reads (docs/12-NFR.md: "offline reads, no offline writes").
// Network-first, falling back to cache only when the network is actually
// unreachable -- never cache-first, which would risk serving a stale board
// or earnings page while online just because a copy happened to be cached.
// Only GET requests are ever touched; every mutation (POST/PATCH/DELETE,
// including Next.js Server Actions, which POST to the page's own URL) is
// untouched and always goes straight to the network, so a write can never
// be silently served from -- or trapped in -- this cache.
const CACHE_NAME = "desire-offline-reads-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Only a genuinely successful response is worth caching -- an
        // error page cached under a read route would be a worse offline
        // experience than no cache at all.
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached ?? Response.error())),
  );
});
