"use client";

import dynamic from "next/dynamic";

// Everything below runs in the browser only: pdf.js, tesseract workers, canvas.
const AppShell = dynamic(() => import("@/components/AppShell"), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-line2 border-t-accent" />
        <p className="text-sm text-muted">Loading PDF Scan Lite…</p>
      </div>
    </div>
  ),
});

export default function ClientShell() {
  return <AppShell />;
}
