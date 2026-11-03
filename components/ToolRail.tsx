"use client";

import { useEffect, useRef } from "react";
import {
  Baseline,
  Eraser,
  Highlighter,
  Images,
  MousePointer2,
  PenTool,
  Signature,
  Trash2,
  X,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { INK_COLORS, HIGHLIGHT_COLORS, FONT_CHOICES } from "@/lib/config";
import { IconButton, Segmented, Slider } from "./ui";
import { useShell } from "./AppShell";
import type { ToolId } from "@/types";

const TOOLS: { id: ToolId; icon: React.ReactNode; label: string; hint: string }[] = [
  { id: "select", icon: <MousePointer2 size={16} />, label: "Select", hint: "Move & resize" },
  { id: "text", icon: <Baseline size={16} />, label: "Text", hint: "Add text box" },
  { id: "pen", icon: <PenTool size={16} />, label: "Pen", hint: "Freehand ink" },
  { id: "marker", icon: <Highlighter size={16} />, label: "Highlight", hint: "Marker" },
  { id: "erase", icon: <Eraser size={16} />, label: "Erase", hint: "White-out" },
  { id: "sign", icon: <Signature size={16} />, label: "Sign", hint: "Draw signature" },
  { id: "image", icon: <Images size={16} />, label: "Image", hint: "Stamp a picture" },
];

export default function ToolRail() {
  const store = useStore();
  const shell = useShell();
  const { tool, setTool, tools, setTools } = store;
  const railRef = useRef<HTMLDivElement | null>(null);

  /**
   * Publish the rail's real height as `--rail-h` so the page area can reserve
   * exactly that much space. Without it the floating rail sits ON TOP of the
   * bottom of the page — very noticeable on short screens and on landscape
   * pages, where the document ends right where the rail begins.
   *
   * It also publishes `--rail-top`, the distance from the top of the scrolling
   * pane to the top of the rail. The viewport needs that one too: reserving
   * bottom padding only helps once the content actually scrolls, but a
   * fit-to-screen page never scrolls, so it just sat underneath the rail. The
   * fit has to be computed against the space above the rail instead.
   */
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const apply = () => {
      const rect = el.getBoundingClientRect();
      const h = Math.ceil(rect.height);
      document.documentElement.style.setProperty("--rail-h", `${h}px`);
      // The rail is a sibling of the scrolling pane, not a child of it.
      const pane = document.querySelector(".scroll-thin");
      if (pane) {
        const top = Math.max(0, Math.round(rect.top - pane.getBoundingClientRect().top));
        document.documentElement.style.setProperty("--rail-top", `${top}px`);
      }
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--rail-h");
      document.documentElement.style.removeProperty("--rail-top");
    };
  }, []);

  return (
    <div
      ref={railRef}
      data-rail
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 pb-3"
    >
      {/* contextual options */}
      {tool !== "select" ? (
        <div className="pointer-events-auto animate-pop flex max-w-[min(94vw,640px)] flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line2 bg-panel/95 px-3 py-2 shadow-xl backdrop-blur">
          {(tool === "text" || tool === "pen") && (
            <div className="flex items-center gap-1.5">
              {INK_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setTools((t) => ({ ...t, color: c }))}
                  className={`h-5 w-5 rounded-full border transition-transform hover:scale-110 ${
                    tools.color === c ? "ring-2 ring-accent ring-offset-2 ring-offset-panel" : "border-line2"
                  }`}
                  style={{ background: c }}
                  title={c}
                />
              ))}
            </div>
          )}

          {tool === "text" ? (
            <>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted">Size</span>
                <input
                  type="range"
                  min={8}
                  max={72}
                  value={tools.fontSize}
                  onChange={(e) => setTools((t) => ({ ...t, fontSize: Number(e.target.value) }))}
                  className="range w-24"
                />
                <span className="tabular w-6 text-[11px] text-ink/80">{tools.fontSize}</span>
              </div>
              <select
                value={tools.fontKey}
                onChange={(e) => setTools((t) => ({ ...t, fontKey: e.target.value as typeof t.fontKey }))}
                className="rounded-md border border-line2 bg-panel2 px-1.5 py-1 text-[11.5px] text-ink outline-none"
              >
                {FONT_CHOICES.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </>
          ) : null}

          {tool === "pen" ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted">Width</span>
              <Slider value={tools.penWidth} min={1} max={14} onChange={(v) => setTools((t) => ({ ...t, penWidth: v }))} />
            </div>
          ) : null}

          {tool === "marker" ? (
            <>
              <div className="flex items-center gap-1.5">
                {HIGHLIGHT_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setTools((t) => ({ ...t, highlightColor: c }))}
                    className={`h-5 w-5 rounded-full border transition-transform hover:scale-110 ${
                      tools.highlightColor === c ? "ring-2 ring-accent ring-offset-2 ring-offset-panel" : "border-line2"
                    }`}
                    style={{ background: c }}
                    title={c}
                  />
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted">Width</span>
                <Slider value={tools.markerWidth} min={6} max={36} onChange={(v) => setTools((t) => ({ ...t, markerWidth: v }))} />
              </div>
            </>
          ) : null}

          {tool === "erase" ? (
            <>
              <Segmented
                value={tools.eraseMode}
                onChange={(v) => setTools((t) => ({ ...t, eraseMode: v }))}
                options={[
                  { value: "white", label: "White-out" },
                  { value: "smart", label: "Match colour" },
                ]}
              />
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted">Brush</span>
                <Slider value={Math.round(tools.penWidth * 4)} min={8} max={64} onChange={(v) => setTools((t) => ({ ...t, penWidth: v / 4 }))} />
              </div>
              <span className="text-[11px] text-dim">Drag to hide · redactions are permanent</span>
            </>
          ) : null}

          {tool === "sign" ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted">Draw a signature, or upload a PNG</span>
              <button
                onClick={() => shell.open("signature")}
                className="rounded-md bg-accent/15 px-2 py-1 text-[11.5px] font-medium text-[#aab2ff] hover:bg-accent/25"
              >
                Signature pad
              </button>
              {tools.signatureDataUrl ? (
                <button
                  onClick={() => setTools((t) => ({ ...t, signatureDataUrl: null }))}
                  className="text-[11px] text-bad hover:underline"
                >
                  clear saved
                </button>
              ) : null}
            </div>
          ) : null}

          {tool === "image" ? (
            <span className="text-[11px] text-dim">Click the page to place an image, or drop one anywhere.</span>
          ) : null}

          <button onClick={() => setTool("select")} className="ml-auto rounded p-1 text-dim hover:bg-panel3 hover:text-ink" title="Close">
            <X size={13} />
          </button>
        </div>
      ) : null}

      {/* tool switcher */}
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border border-line2 bg-panel/95 p-1 shadow-xl backdrop-blur">
        {TOOLS.map((t) => (
          <IconButton
            key={t.id}
            label={`${t.label} — ${t.hint}`}
            active={tool === t.id}
            onClick={() => {
              if (t.id === "sign" && tool === "sign") shell.open("signature");
              else if (t.id === "sign" && !tools.signatureDataUrl) {
                setTool("sign");
                shell.open("signature");
              } else setTool(t.id);
            }}
            className="h-9 w-9"
          >
            {t.icon}
          </IconButton>
        ))}
        <div className="mx-1 h-6 w-px bg-line2" />
        <IconButton
          label="Clear this page"
          onClick={() => store.currentPage && store.clearPage(store.currentPage.id)}
          disabled={!(store.currentPageId && (store.annotations[store.currentPageId]?.length ?? 0))}
        >
          <Trash2 size={15} />
        </IconButton>
      </div>
    </div>
  );
}
