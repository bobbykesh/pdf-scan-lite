"use client";

import { useEffect } from "react";

/**
 * Registers the offline service worker (production builds only).
 *
 * The worker precaches the whole application — including the ~18 MB of pdf.js
 * and Tesseract engine assets — so scanning and OCR keep working offline.
 *
 * Update path
 * -----------
 * The worker itself never asks a page to reload (an earlier attempt did, and it
 * reloaded the page that had just installed it, in a loop). Instead:
 *
 *   1. `/sw.js` is re-fetched on every load and when the tab becomes visible,
 *      so a new deploy is detected quickly;
 *   2. navigations are network-first in the worker, so a fresh page load
 *      always picks up the newest HTML and JS chunks;
 *   3. if a new worker is waiting, the page shows an "Update available"
 *      prompt instead of reloading underneath the user.
 *
 * Result: a deployed update arrives on the next visit, and no reload loops.
 */
export default function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // The dev server has no meaningful SW lifecycle: a stale worker here fights
    // HMR and closes open dialogs. Unregister and clear caches in development.
    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .catch(() => {});
      if ("caches" in window) {
        caches
          .keys()
          .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
          .catch(() => {});
      }
      return;
    }

    let cancelled = false;

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });

        // First install (nothing controlling the page yet) → offline is ready.
        reg.installing?.addEventListener("statechange", (e) => {
          const sw = e.target as ServiceWorker;
          if (sw.state === "installed" && !navigator.serviceWorker.controller) {
            window.dispatchEvent(new CustomEvent("pdfsl:offline-ready"));
          }
        });

        // A deploy is sitting in the wings: let the UI offer a refresh.
        const announce = (worker: ServiceWorker | null) => {
          if (!worker) return;
          if (navigator.serviceWorker.controller) {
            window.dispatchEvent(new CustomEvent("pdfsl:update-ready"));
          }
        };
        announce(reg.waiting);
        reg.addEventListener("updatefound", () => announce(reg.installing));

        // Check for a new build on load, and again when the tab is refocused.
        void reg.update().catch(() => {});
        const onVisible = () => {
          if (document.visibilityState === "visible") void reg.update().catch(() => {});
        };
        document.addEventListener("visibilitychange", onVisible);
        const timer = setInterval(() => {
          if (document.visibilityState === "visible") void reg.update().catch(() => {});
        }, 30 * 60 * 1000);

        return () => {
          document.removeEventListener("visibilitychange", onVisible);
          clearInterval(timer);
        };
      } catch {
        /* offline support is a bonus, never a hard requirement */
      }
    };

    const id = setTimeout(() => {
      if (!cancelled) void register();
    }, 800);

    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, []);

  return null;
}
