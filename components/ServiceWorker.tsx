"use client";

import { useEffect, useRef } from "react";

/**
 * Registers the offline service worker (production builds only).
 *
 * The worker precaches the whole application — including the ~18 MB of
 * pdf.js and Tesseract engine assets — so scanning and OCR keep working with
 * the network switched off. Registration is delayed until the page is idle so
 * it never competes with the first paint.
 */
export default function ServiceWorker() {
  const prompted = useRef(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");

        // Surface download progress for the multi-megabyte first run.
        reg.installing?.addEventListener("statechange", (e) => {
          const sw = e.target as ServiceWorker;
          if (sw.state === "installed" && !prompted.current && !navigator.serviceWorker.controller) {
            prompted.current = true;
            window.dispatchEvent(new CustomEvent("pdfsl:offline-ready"));
          }
        });

        // Claim newly activated workers so the very first offline reload is
        // served from cache instead of the network.
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (!cancelled) window.dispatchEvent(new CustomEvent("pdfsl:sw-active"));
        });

        if (reg.waiting) {
          // A new build finished installing; activate it on the next visit.
          prompted.current = true;
        }
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
