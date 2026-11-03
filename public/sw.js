/* PDF Scan Lite service worker — full offline support.
 *
 * Registered from components/ServiceWorker.tsx.
 *
 * Strategy
 *   install  : download the entire application — JS/CSS chunks, the pdf.js
 *              worker, cmaps, standard fonts, WASM codecs and the Tesseract
 *              engine + English language data (~18 MB) — into one cache.
 *              After this completes the app runs with the network switched off.
 *   activate : drop caches from previous builds.
 *   fetch    : network-first for navigations (so a deployed update always
 *              arrives), cache-first for the immutable prefetched assets.
 *
 * The asset list is generated at build time by scripts/copy-vendor-assets.mjs
 * into /offline-assets.json, so it can never drift from the real files.
 */

const VERSION = "pdfsl-v3";
const CACHE = `${VERSION}-offline`;
const MANIFEST_URL = "/offline-assets.json";
const SHELL_URLS = ["/", "/manifest.webmanifest", "/icon.svg", "/offline-assets.json"];

/** Collect every URL hashed into the build's JS/CSS. */
async function discoverBuildAssets() {
  const found = new Set();
  try {
    const res = await fetch("/", { cache: "no-store" });
    const html = await res.clone().text();
    // Precache the document itself so the first offline load works.
    await (await caches.open(CACHE)).put("/", res);

    for (const m of html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)) found.add(m[1]);
    // Flight/RSC payloads reference additional chunks as plain JSON strings.
    for (const m of html.matchAll(/"(\/_next\/static\/[^"]+\.(?:js|css|woff2?))"/g)) found.add(m[1]);

    // Chunks can import each other; follow one level of references.
    for (const url of [...found]) {
      if (!url.endsWith(".js")) continue;
      try {
        const body = await (await fetch(url, { cache: "no-store" })).text();
        for (const m of body.matchAll(/"(\/_next\/static\/[^"]+\.(?:js|css))"/g)) found.add(m[1]);
      } catch {
        /* a missing chunk is not fatal — the rest still works */
      }
    }
  } catch {
    /* offline install of an online-first visit — shell only */
  }
  return [...found];
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);

      // 1. The engine assets, straight from the build-generated manifest.
      let engineUrls = [];
      try {
        const res = await fetch(MANIFEST_URL, { cache: "no-store" });
        const manifest = await res.json();
        engineUrls = manifest.urls || [];
      } catch {
        /* manifest absent (very old deploy) — carry on with the shell */
      }

      // 2. The build's own JS/CSS, discovered from the served HTML.
      const buildUrls = await discoverBuildAssets();

      const all = [...new Set([...SHELL_URLS, ...engineUrls, ...buildUrls])];

      // Warm the cache in small batches: 200 parallel requests to a CDN can
      // trip rate limits and leave holes in the offline set.
      const BATCH = 12;
      for (let i = 0; i < all.length; i += BATCH) {
        const slice = all.slice(i, i + BATCH);
        await Promise.all(
          slice.map(async (url) => {
            try {
              if (await cache.match(url)) return;
              const res = await fetch(url, { cache: "no-cache" });
              // opaque cross-origin responses are fine to store as-is
              if (res.ok || res.type === "opaque") await cache.put(url, res);
            } catch {
              /* skip and keep going */
            }
          })
        );
      }

      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  // Let the page ask "how much is actually cached?" for the offline badge.
  const isStatus = event.data === "cache-status" || event.data?.type === "cache-status";
  if (!isStatus) return;
  const reply = (entries) => {
    const payload = { type: "cache-status", entries };
    if (event.ports && event.ports[0]) event.ports[0].postMessage(payload);
    else event.source?.postMessage(payload);
  };
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.keys())
      .then((keys) => reply(keys.length))
      .catch(() => reply(0))
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  /* ------------------------------------------------------------------------
   * Navigations are NETWORK-FIRST.
   *
   * The previous version was cache-first for everything, including the HTML.
   * Once installed, a deployed update could never reach the user: the cached
   * document always won, and it pointed at the old build's chunks (which were
   * also cached). That is why a new version needed incognito to appear.
   * ---------------------------------------------------------------------- */
  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(
      fetch(req, { cache: "no-store" })
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("/", copy)).catch(() => {});
          }
          return res;
        })
        .catch(async () => {
          // Offline: serve the last known document, then the precached shell.
          return (await caches.match(req)) || (await caches.match("/")) || Response.error();
        })
    );
    return;
  }

  // Cache-first: everything else precached is immutable for this build.
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;

      return fetch(req)
        .then((res) => {
          // Remember new GET-able assets (e.g. a language file added later).
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(async () => {
          // Offline and not cached: navigations still resolve to the app shell.
          if (req.mode === "navigate" || req.destination === "document") {
            const shell = await caches.match("/");
            if (shell) return shell;
          }
          return Response.error();
        });
    })
  );
});
