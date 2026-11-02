"use client";

import { Camera, Download, FolderOpen, Menu } from "lucide-react";
import { useStore } from "@/lib/store";
import { useShell } from "./AppShell";

/**
 * Bottom action bar for phones/tablets.
 *
 * On mobile the app behaves like a native scanning app: thumb-reachable
 * primary actions pinned to the bottom, a page drawer instead of a permanent
 * sidebar, and no shrink-wrapped desktop toolbar. On desktop this component is
 * not rendered at all (see AppShell) — the full toolbar is used instead.
 */
export default function MobileActionBar({ onOpenPages }: { onOpenPages: () => void }) {
  const store = useStore();
  const shell = useShell();
  const hasPages = store.pages.length > 0;

  const item =
    "flex flex-1 flex-col items-center justify-center gap-1 rounded-xl px-2 py-2 text-[10.5px] font-medium transition-colors active:scale-[0.97] disabled:opacity-40";

  return (
    <nav
      aria-label="Primary actions"
      className="z-30 flex shrink-0 items-stretch gap-1 border-t border-line bg-panel/95 px-2 pb-[max(6px,env(safe-area-inset-bottom))] pt-1.5 backdrop-blur lg:hidden"
    >
      <button
        type="button"
        onClick={onOpenPages}
        className={`${item} border border-line2 bg-panel2 text-ink`}
        aria-label={`Pages (${store.pages.length})`}
      >
        <Menu size={19} />
        Pages{hasPages ? ` (${store.pages.length})` : ""}
      </button>

      <button
        type="button"
        onClick={() => shell.open("scanner")}
        className={`${item} border border-line2 bg-panel2 text-ink`}
        aria-label="Scan with camera"
      >
        <Camera size={19} />
        Scan
      </button>

      <label
        className={`${item} cursor-pointer border border-line2 bg-panel2 text-ink`}
        aria-label="Open a file or photo"
      >
        <FolderOpen size={19} />
        Open
        <input
          type="file"
          accept="application/pdf,image/*"
          multiple
          className="sr-only"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) void shell.importFiles(files);
          }}
        />
      </label>

      <button
        type="button"
        onClick={() => shell.open("export")}
        disabled={!hasPages}
        className={`${item} bg-accent text-white shadow-lg shadow-accent/20`}
        aria-label="Export the document"
      >
        <Download size={19} />
        Export
      </button>
    </nav>
  );
}
