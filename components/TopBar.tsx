"use client";

import { useEffect, useRef, useState } from "react";
import {
  Camera,
  ChevronDown,
  Download,
  FilePlus2,
  FolderOpen,
  ImagePlus,
  Loader2,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Redo2,
  RotateCcw,
  RotateCw,
  ScanText,
  Share2,
  Undo2,
  X,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { useShell } from "./AppShell";
import { Button, IconButton } from "./ui";
import { runOcrBatch } from "@/lib/ocrBatch";
import type { OcrWord } from "@/types";

export default function TopBar({
  onToggleSidebar,
  sidebarOpen,
  onOpenWord,
}: {
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
  onOpenWord: (word: OcrWord, pageId: string) => void;
}) {
  const store = useStore();
  const shell = useShell();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [menu, setMenu] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const hasPages = store.pages.length > 0;

  // move focus into the menu instead of reading a ref during render
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector("button")?.focus();
  }, [menu]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const target = e.target as HTMLElement;
      const typing = /INPUT|TEXTAREA/.test(target.tagName) || target.isContentEditable;
      if (e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      }
      if (e.key.toLowerCase() === "y" && !typing) {
        e.preventDefault();
        store.redo();
      }
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (hasPages) shell.open("export");
      }
      if (e.key.toLowerCase() === "o") {
        e.preventDefault();
        fileRef.current?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, shell, hasPages]);

  const runOcr = async () => {
    if (!store.pages.length || ocrBusy) return;
    setOcrBusy(true);
    try {
      const pending = store.pages.filter((p) => !p.ocr || p.ocrState === "error");
      const targets = pending.length ? pending : store.pages;
      await runOcrBatch(targets, {
        onProgress: (done, total, status) => shell.setBusy(`OCR ${done}/${total} · ${status}`),
        onPageDone: (pageId, result) => {
          store.setPageOcr(pageId, result, "done");
        },
        onError: (pageId) => store.setPageOcr(pageId, undefined, "error"),
      });
      shell.toast("Text layer ready — tap any word to edit it");
      store.setTool("select");
    } catch (err) {
      console.error(err);
      shell.toast("OCR failed. Check your connection for the language data.", "err");
    } finally {
      setOcrBusy(false);
      shell.setBusy(null);
    }
  };

  const ocrCount = store.pages.filter((p) => p.ocr?.words?.length).length;

  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel/90 px-2.5 backdrop-blur md:px-4">
      <button
        onClick={onToggleSidebar}
        className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-panel3 hover:text-ink"
        title={sidebarOpen ? "Hide pages" : "Show pages"}
      >
        {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
      </button>

      <div className="flex items-center gap-2.5">
        <div className="grid h-8 w-8 place-items-center rounded-[9px] bg-gradient-to-br from-accent to-accent2 shadow-[0_4px_14px_-6px_#6d7cff]">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M7 3.5h7L19 8v12.5H7z" stroke="white" strokeWidth="1.7" strokeLinejoin="round" />
            <path d="M14 3.5V8h5" stroke="white" strokeWidth="1.7" strokeLinejoin="round" />
            <path d="M4.5 7v13.5h11" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity=".55" />
          </svg>
        </div>
        <div className="hidden leading-none sm:block">
          <p className="text-[13.5px] font-semibold tracking-tight">PDF Scan Lite</p>
          <p className="mt-1 text-[10.5px] text-dim">100% on-device</p>
        </div>
      </div>

      <div className="mx-1 hidden h-6 w-px bg-line md:block" />

      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void shell.importFiles(files);
        }}
      />

      <div className="flex items-center gap-1.5">
        <Button variant="soft" size="md" onClick={() => fileRef.current?.click()} className="hidden xs:inline-flex sm:inline-flex">
          <FolderOpen size={15} />
          <span className="hidden sm:inline">Open</span>
        </Button>
        <Button variant="primary" size="md" onClick={() => shell.open("scanner")}>
          <Camera size={15} />
          <span className="hidden sm:inline">Scan</span>
        </Button>
      </div>

      {hasPages ? (
        <>
          <div className="mx-1 hidden h-6 w-px bg-line sm:block" />
          <div className="hidden items-center gap-0.5 sm:flex">
            <IconButton label="Undo (⌘Z)" onClick={store.undo} disabled={!store.canUndo}>
              <Undo2 size={16} />
            </IconButton>
            <IconButton label="Redo (⇧⌘Z)" onClick={store.redo} disabled={!store.canRedo}>
              <Redo2 size={16} />
            </IconButton>
            <IconButton label="Rotate page left" onClick={() => store.currentPage && store.rotatePage(store.currentPage.id, -1)}>
              <RotateCcw size={16} />
            </IconButton>
            <IconButton label="Rotate page right" onClick={() => store.currentPage && store.rotatePage(store.currentPage.id, 1)}>
              <RotateCw size={16} />
            </IconButton>
          </div>

          <div className="hidden items-center gap-2 rounded-lg border border-line bg-panel2 px-2.5 py-1.5 lg:flex">
            <ScanText size={14} className={ocrCount ? "text-good" : "text-muted"} />
            <input
              value={store.docName}
              onChange={(e) => store.setDocName(e.target.value)}
              className="w-36 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-dim"
              placeholder="File name"
              aria-label="Document name"
            />
          </div>
        </>
      ) : null}

      <div className="ml-auto flex items-center gap-1.5">
        {hasPages ? (
          <Button
            variant="outline"
            size="md"
            onClick={runOcr}
            disabled={ocrBusy}
            className="hidden md:inline-flex"
            title="Recognise text on every page (runs locally)"
          >
            {ocrBusy ? <Loader2 size={15} className="animate-spin" /> : <ScanText size={15} />}
            {ocrBusy ? "Recognising…" : ocrCount === store.pages.length && ocrCount > 0 ? "Text ready" : "OCR"}
          </Button>
        ) : null}

        <Button variant="primary" size="md" onClick={() => shell.open("export")} disabled={!hasPages}>
          <Download size={15} />
          <span className="hidden sm:inline">Export</span>
        </Button>

        <div className="relative">
          <IconButton label="More" onClick={() => setMenu((v) => !v)} active={menu}>
            <MoreHorizontal size={17} />
          </IconButton>
          {menu ? (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
              <div className="animate-pop absolute right-0 top-11 z-50 w-56 overflow-hidden rounded-xl border border-line2 bg-panel shadow-2xl">
                {[
                  {
                    icon: <ImagePlus size={15} />,
                    label: "Add images",
                    action: () => fileRef.current?.click(),
                    show: true,
                  },
                  {
                    icon: <FilePlus2 size={15} />,
                    label: "Scan with camera",
                    action: () => shell.open("scanner"),
                    show: true,
                  },
                  {
                    icon: <ScanText size={15} />,
                    label: ocrCount ? "Re-run text recognition" : "Recognise text (OCR)",
                    action: runOcr,
                    show: hasPages,
                  },
                  {
                    icon: <Download size={15} />,
                    label: "Compress & resize",
                    action: () => shell.open("compress"),
                    show: hasPages,
                  },
                  {
                    icon: <Share2 size={15} />,
                    label: "Share / export…",
                    action: () => shell.open("export"),
                    show: hasPages,
                  },
                  {
                    icon: <X size={15} />,
                    label: "Close document",
                    action: () => {
                      if (!store.dirty || window.confirm("Discard this document? Unsaved edits will be lost.")) {
                        store.reset();
                      }
                    },
                    show: hasPages,
                  },
                ]
                  .filter((i) => i.show)
                  .map((item) => (
                    <button
                      key={item.label}
                      onClick={() => {
                        setMenu(false);
                        void item.action();
                      }}
                      className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13px] text-ink/90 hover:bg-panel2"
                    >
                      <span className="text-muted">{item.icon}</span>
                      {item.label}
                    </button>
                  ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}
