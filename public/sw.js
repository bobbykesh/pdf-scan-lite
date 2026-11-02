/* PDF Scan Lite service worker — offline shell + immutable vendor assets.
 * Registered from components/ServiceWorker.tsx (production only).
 * Strategy:
 *   - app shell / documents: network-first, fall back to cache
 *   - /vendor, /cmaps, /standard_fonts, /pdf-wasm, *.worker.* : cache-first
 */
const VERSION = "pdfsl-v1";
const SHELL = `${VERSION}-shell`;
const VENDOR = `${VERSION}-vendor`;
const SHELL_URLS = ["/", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(SHELL_URLS).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isVendor = (url) =>
  /\/vendor\/|\/cmaps\/|\/standard_fonts\/|\/pdf-wasm\/|\.worker\.(min\.)?(js|mjs)$/.test(url.pathname);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache the BigDataCloud-free html shell while developing.
  if (isVendor(url.href)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(VENDOR).then((c) => c.put(req, copy)).catch(() => {});
            return res;
          })
      )
    );
    return;
  }

  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("/")))
    );
  }
});
