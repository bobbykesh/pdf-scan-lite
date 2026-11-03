"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StoreProvider, useStore } from "@/lib/store";
import { pdfStore } from "@/lib/pdfStore";
import { importPdf, isImageFile, isPdfFile, pageFromImage, readFileBytes, readFileDataUrl, thumbnailFor } from "@/lib/document";
import { makeSamplePdf } from "@/lib/sample";
import { uid } from "@/lib/utils";
import type { PageMeta } from "@/types";
import TopBar from "./TopBar";
import Thumbnails from "./Thumbnails";
import Viewport from "./Viewport";
import ToolRail from "./ToolRail";
import MobileActionBar from "./MobileActionBar";
import ScannerModal from "./ScannerModal";
import ExportModal from "./ExportModal";
import CompressModal from "./CompressModal";
import SignatureModal from "./SignatureModal";
import WordEditModal from "./WordEditModal";
import Welcome from "./Welcome";
import { applyServiceWorkerUpdate } from "./ServiceWorker";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import type { OcrWord } from "@/types";

export type ModalKind = null | "scanner" | "export" | "compress" | "signature" | "word";

interface Toast {
  id: string;
  kind: "ok" | "err" | "info";
  text: string;
  /** Optional label for a primary button in the toast (e.g. "Refresh"). */
  action?: string;
  onAction?: () => void;
}

export interface ShellApi {
  open: (m: ModalKind, payload?: unknown) => void;
  close: () => void;
  modal: ModalKind;
  payload: unknown;
  toast: (text: string, kind?: Toast["kind"]) => void;
  importFiles: (files: File[]) => Promise<void>;
  importBytes: (bytes: Uint8Array, name: string) => Promise<void>;
  loadSample: () => Promise<void>;
  busy: string | null;
  setBusy: (s: string | null) => void;
  editingWord: { word: OcrWord; pageId: string } | null;
}

function Workspace() {
  const store = useStore();
  const [modal, setModal] = useState<ModalKind>(null);
  const [payload, setPayload] = useState<unknown>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const [busy, setBusy] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => {
    // desktop shows the page rail by default, phones start with the full viewport
    setSidebarOpen(window.innerWidth >= 1024);
  }, []);
  const [editingWord, setEditingWord] = useState<{ word: OcrWord; pageId: string } | null>(null);
  const thumbsQueued = useRef(new Set<string>());

  const toast = useCallback(
    (
      text: string,
      kind: Toast["kind"] = "ok",
      action?: { label: string; onAction: () => void }
    ) => {
      const id = uid("t");
      // Only ever show one message: stacking two banners over the document
      // hides the top of the page on phones, and the older line is stale anyway.
      setToasts([{ id, kind, text, action: action?.label, onAction: action?.onAction }]);
      // A toast with a button is the only way to take an update, so it stays
      // until the user acts on it (or dismisses it) instead of vanishing.
      if (!action) {
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4200);
      }
    },
    []
  );

  // The service worker announces when the offline cache is complete.
  useEffect(() => {
    const onReady = () =>
      toast("Saved for offline use — the scanner now works without a signal.", "ok");
    // A new build downloaded itself and is waiting: offer a one-tap refresh
    // instead of reloading underneath the user (never interrupt mid-scan).
    const onUpdate = () => {
      toast("A new version is ready.", "info", {
        label: "Refresh",
        onAction: () => applyServiceWorkerUpdate(),
      });
    };
    window.addEventListener("pdfsl:offline-ready", onReady);
    window.addEventListener("pdfsl:update-ready", onUpdate);
    return () => {
      window.removeEventListener("pdfsl:offline-ready", onReady);
      window.removeEventListener("pdfsl:update-ready", onUpdate);
    };
  }, [toast]);
  const open = useCallback((m: ModalKind, p?: unknown) => {
    setPayload(p ?? null);
    setModal(m);
  }, []);
  const close = useCallback(() => setModal(null), []);

  /* ----------------------------------------------------- thumbnail builder */

  const buildThumbs = useCallback(
    async (pages: PageMeta[]) => {
      for (const page of pages) {
        if (page.thumb || thumbsQueued.current.has(`${page.id}:${page.rotation}`)) continue;
        thumbsQueued.current.add(`${page.id}:${page.rotation}`);
        try {
          const thumb = await thumbnailFor(page, 280);
          store.setPages((prev) => prev.map((p) => (p.id === page.id ? { ...p, thumb } : p)));
        } catch {
          /* skip */
        }
      }
    },
    [store]
  );

  useEffect(() => {
    const missing = store.pages.filter((p) => !p.thumb);
    if (!missing.length) return;
    const t = setTimeout(() => void buildThumbs(missing), 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.pages.map((p) => p.id + p.rotation).join(",")]);

  /* --------------------------------------------------------------- imports */

  const importBytes = useCallback(
    async (bytes: Uint8Array, name: string) => {
      setBusy("Reading PDF…");
      try {
        const { ref, pages } = await importPdf(bytes, name);
        void ref;
        store.setPages((prev) => [...prev, ...pages]);
        if (!store.currentPageId) store.setCurrentPageId(pages[0]?.id ?? "");
        store.setDocName(name.replace(/\.pdf$/i, "") || "scanned-document");
        toast(`${pages.length} page${pages.length === 1 ? "" : "s"} added`);
      } catch (err) {
        console.error(err);
        toast("That PDF could not be opened. It may be encrypted or corrupt.", "err");
      } finally {
        setBusy(null);
      }
    },
    [store, toast]
  );

  const importFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const pdfs = files.filter(isPdfFile);
      const images = files.filter(isImageFile);
      const others = files.filter((f) => !isPdfFile(f) && !isImageFile(f));
      if (others.length) toast(`${others.length} unsupported file(s) skipped`, "info");

      for (const f of pdfs) {
        const bytes = await readFileBytes(f);
        await importBytes(bytes, f.name);
      }
      if (images.length) {
        setBusy(`Importing ${images.length} image${images.length === 1 ? "" : "s"}…`);
        try {
          const pages: PageMeta[] = [];
          for (const f of images) {
            const dataUrl = await readFileDataUrl(f);
            pages.push(await pageFromImage(dataUrl, f.type || "image/jpeg"));
          }
          store.setPages((prev) => [...prev, ...pages]);
          if (!store.currentPageId) store.setCurrentPageId(pages[0]?.id ?? "");
          toast(`${pages.length} image${pages.length === 1 ? "" : "s"} added`);
        } catch {
          toast("Could not read those images", "err");
        } finally {
          setBusy(null);
        }
      }
    },
    [importBytes, store, toast]
  );

  const loadSample = useCallback(async () => {
    setBusy("Preparing sample…");
    try {
      const bytes = await makeSamplePdf();
      await importBytes(bytes, "sample-invoice.pdf");
    } finally {
      setBusy(null);
    }
  }, [importBytes]);

  const api: ShellApi = {
    open,
    close,
    modal,
    payload,
    toast,
    importFiles,
    importBytes,
    loadSample,
    busy,
    setBusy,
    editingWord,
  };

  const hasPages = store.pages.length > 0;

  return (
    <ShellContext.Provider value={api}>
      <div className="flex h-dvh flex-col overflow-hidden bg-canvas">
        <TopBar
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          sidebarOpen={sidebarOpen}
          onOpenWord={(word, pageId) => {
            setEditingWord({ word, pageId });
            setModal("word");
          }}
        />

        {hasPages ? (
          <div className="flex min-h-0 flex-1">
            {sidebarOpen ? (
              <button
                aria-label="Close pages"
                onClick={() => setSidebarOpen(false)}
                className="fixed inset-0 z-20 bg-black/50 backdrop-blur-[1px] lg:hidden"
              />
            ) : null}
            <aside
              className={`${
                sidebarOpen ? "flex" : "hidden"
              } fixed inset-y-14 left-0 z-30 w-[190px] shrink-0 flex-col border-r border-line bg-panel shadow-2xl lg:static lg:z-auto lg:w-[196px] lg:shadow-none`}
            >
              <Thumbnails />
            </aside>
            <main className="relative flex min-w-0 flex-1 flex-col">
              <Viewport
                onEditWord={(word, pageId) => {
                  setEditingWord({ word, pageId });
                  setModal("word");
                }}
              />
              <ToolRail />
            </main>
          </div>
        ) : (
          <Welcome />
        )}

        {/* Phones and tablets get a native-style bottom action bar. */}
        <MobileActionBar onOpenPages={() => setSidebarOpen(true)} />

        {/* floating busy pill */}
        {busy ? (
          <div className="pointer-events-none fixed left-1/2 top-16 z-40 -translate-x-1/2">
            <div className="flex items-center gap-2.5 rounded-full border border-line2 bg-panel/95 px-4 py-2 text-[13px] text-ink shadow-xl backdrop-blur">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-accent border-t-transparent" />
              {busy}
            </div>
          </div>
        ) : null}

        {/* toasts */}
        <div className="pointer-events-none fixed left-1/2 top-[calc(3.6rem+env(safe-area-inset-top))] z-[60] flex w-full max-w-sm -translate-x-1/2 flex-col gap-2 px-4 lg:bottom-4 lg:top-auto">
          {toasts.map((t) => (
            <div
              key={t.id}
              className="animate-pop pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line2 bg-panel/95 px-3.5 py-2.5 text-[13px] shadow-2xl backdrop-blur"
            >
              {t.kind === "ok" ? (
                <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-good" />
              ) : t.kind === "err" ? (
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-bad" />
              ) : (
                <Info size={16} className="mt-0.5 shrink-0 text-accent" />
              )}
              <span className="flex-1 leading-snug text-ink/90">{t.text}</span>
              {t.action ? (
                <button
                  onClick={() => {
                    setToasts((prev) => prev.filter((x) => x.id !== t.id));
                    t.onAction?.();
                  }}
                  className="shrink-0 rounded-lg bg-accent px-2.5 py-1 text-[12px] font-medium text-white"
                >
                  {t.action}
                </button>
              ) : null}
              <button
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
                className="text-dim hover:text-ink"
                aria-label="Dismiss"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>

        <ScannerModal />
        <ExportModal />
        <CompressModal />
        <SignatureModal />
        <WordEditModal />
      </div>
    </ShellContext.Provider>
  );
}

import { createContext, useContext } from "react";

const ShellContext = createContext<ShellApi | null>(null);

export function useShell() {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside AppShell");
  return ctx;
}

export default function AppShell() {
  return (
    <StoreProvider>
      <Workspace />
    </StoreProvider>
  );
}
