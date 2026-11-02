"use client";

import { useEffect } from "react";

/** Registers the offline service worker (production builds only). */
export default function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const id = setTimeout(() => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* offline support is a bonus, never a hard requirement */
      });
    }, 1200);
    return () => clearTimeout(id);
  }, []);
  return null;
}
