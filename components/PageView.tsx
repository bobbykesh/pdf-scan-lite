"use client";

/**
 * Interactive page layers.
 *
 *   PDFCanvas   – <canvas> showing the source page; annotations are painted on
 *                 top of the same canvas after the base render (single element,
 *                 pixel-perfect with the exporter).
 *   OcrLayer    – invisible, hoverable word boxes from OCR; click to edit text
 *                 in place. Replaced words are erased from the pixels on export.
 *   AnnoLayer   – DOM handles for select / move / resize / delete.
 *   LiveStroke  – the pen stroke currently being drawn.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Annotation, DrawAnn, OcrWord, PageMeta, Point, Rect, TextAnn } from "@/types";
import { paintAnnotations, paintBase, drawText, isErasedWord } from "@/lib/stamp";
import { displaySize } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { uid } from "@/lib/utils";

/* ------------------------------------------------------------------ canvas */

export function PDFCanvas({
  meta,
  widthPx,
  heightPx,
  annotations,
  excludeIds,
  onReady,
}: {
  meta: PageMeta;
  widthPx: number;
  heightPx: number;
  annotations: Annotation[];
  excludeIds?: string[];
  onReady?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);
  const renderKey = JSON.stringify([meta.id, meta.rotation, meta.source, meta.ocr?.at, widthPx, heightPx]);
  const annKey = JSON.stringify([annotations, excludeIds]);

  useEffect(() => {
    let cancelled = false;
    const canvas = ref.current;
    if (!canvas) return;
    setReady(false);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(widthPx * dpr);
    canvas.height = Math.round(heightPx * dpr);
    canvas.style.width = `${widthPx}px`;
    canvas.style.height = `${heightPx}px`;
    (async () => {
      try {
        await paintBase(canvas, meta);
        if (cancelled) return;
        setReady(true);
        onReady?.();
      } catch {
        /* page render failed — leave a blank sheet */
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey, widthPx, heightPx]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !ready) return;
    let cancelled = false;
    (async () => {
      try {
        await paintBase(canvas, meta);
        const ctx = canvas.getContext("2d")!;
        const dpr = canvas.width / widthPx;
        const { w: wPt } = displaySize(meta);
        const k = (widthPx / wPt) * dpr;
        const hide = new Set(excludeIds ?? []);
        await paintAnnotations(ctx, annotations, k, hide, canvas);
        if (cancelled) return;
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annKey, ready, widthPx, heightPx]);

  return (
    <canvas
      ref={ref}
      className="block rounded-[2px] bg-white"
      style={{ width: widthPx, height: heightPx }}
    />
  );
}

/* -------------------------------------------------------------- OCR layer */

export function OcrLayer({
  pageId,
  words,
  active,
  widthPx,
  heightPx,
  pageWidthPt,
  onEdit,
}: {
  pageId: string;
  words: OcrWord[];
  active: boolean;
  widthPx: number;
  heightPx: number;
  pageWidthPt: number;
  onEdit: (word: OcrWord) => void;
}) {
  if (!active) return null;
  const s = widthPx / pageWidthPt;
  return (
    <div
      className="absolute inset-0"
      data-ocr-layer
      style={{ pointerEvents: "auto" }}
      onPointerDownCapture={(e) => {
        // don't start a selection/drawing gesture when the user taps a word
        e.stopPropagation();
      }}
    >
      {words.map((word, i) => {
        if (isErasedWord(word)) return null;
        return (
          <div
            key={`${pageId}-${i}-${word.text}`}
            className="ocr-word"
            title={`${word.text} · ${Math.round(word.conf)}%`}
            style={{
              left: word.x * s,
              top: word.y * s,
              width: word.w * s,
              height: word.h * s,
            }}
            onClick={(e) => {
              e.stopPropagation();
              onEdit(word);
            }}
          />
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ anno handles */

export function AnnoLayer({
  annotations,
  tool,
  selectedId,
  hiddenIds,
  widthPx,
  heightPx,
  pageWidthPt,
  onSelect,
  onChange,
  onEditText,
}: {
  annotations: Annotation[];
  tool: string;
  selectedId: string | null;
  hiddenIds: string[];
  widthPx: number;
  heightPx: number;
  pageWidthPt: number;
  onSelect: (id: string | null) => void;
  onChange: (id: string, rect: Rect) => void;
  onEditText: (id: string) => void;
}) {
  const s = widthPx / pageWidthPt;
  const interactive = tool === "select" || tool === "text";
  const drag = useRef<{
    id: string;
    mode: "move" | "resize";
    startX: number;
    startY: number;
    rect: Rect;
    corner: number;
  } | null>(null);

  const visible = annotations.filter(
    (a) => !hiddenIds.includes(a.id) && a.type !== "draw" && a.type !== "redact"
  );

  const begin = (e: React.PointerEvent, a: Annotation, mode: "move" | "resize", corner = 0) => {
    if (!interactive) return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const rect = a.type === "text" || a.type === "image" ? a.rect : { x: 0, y: 0, w: 0, h: 0 };
    drag.current = { id: a.id, mode, startX: e.clientX, startY: e.clientY, rect, corner };
    onSelect(a.id);
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / s;
    const dy = (e.clientY - d.startY) / s;
    if (d.mode === "move") {
      onChange(d.id, { x: d.rect.x + dx, y: d.rect.y + dy, w: d.rect.w, h: d.rect.h });
    } else {
      const minW = 24;
      const minH = 16;
      let { x, y, w, h } = d.rect;
      if (d.corner === 0) {
        x = d.rect.x + dx;
        y = d.rect.y + dy;
        w = d.rect.w - dx;
        h = d.rect.h - dy;
      } else if (d.corner === 1) {
        y = d.rect.y + dy;
        w = d.rect.w + dx;
        h = d.rect.h - dy;
      } else if (d.corner === 2) {
        w = d.rect.w + dx;
        h = d.rect.h + dy;
      } else {
        x = d.rect.x + dx;
        w = d.rect.w - dx;
        h = d.rect.h + dy;
      }
      onChange(d.id, { x, y, w: Math.max(minW, w), h: Math.max(minH, h) });
    }
  };

  const end = () => {
    drag.current = null;
  };

  return (
    <div className="absolute inset-0" style={{ pointerEvents: interactive ? "auto" : "none" }}>
      {visible.map((a) => {
        const r = a.type === "text" || a.type === "image" ? a.rect : null;
        if (!r) return null;
        const isSel = selectedId === a.id;
        const isText = a.type === "text";
        return (
          <div
            key={a.id}
            className={`absolute ${isSel ? "sel-ring" : ""}`}
            style={{
              left: r.x * s,
              top: r.y * s,
              width: r.w * s,
              height: r.h * s,
              cursor: interactive ? "move" : "default",
              touchAction: "none",
            }}
            onPointerDown={(e) => begin(e, a, "move")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onDoubleClick={(e) => {
              if (isText) {
                e.stopPropagation();
                onEditText(a.id);
              }
            }}
          >
            {isSel &&
              [
                [0, 0],
                [1, 0],
                [2, 2],
                [0, 2],
              ].map(([cx, cy], i) => (
                <span
                  key={i}
                  onPointerDown={(e) => begin(e, a, "resize", i)}
                  onPointerMove={move}
                  onPointerUp={end}
                  className="absolute h-2.5 w-2.5 rounded-[2px] border border-white bg-accent shadow"
                  style={{
                    left: cx === 0 ? -5 : undefined,
                    right: cx === 1 ? -5 : undefined,
                    top: cy === 0 ? -5 : undefined,
                    bottom: cy === 2 ? -5 : undefined,
                    cursor: i === 2 ? "nwse-resize" : i === 0 ? "nwse-resize" : "nesw-resize",
                  }}
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------- live stroke */

export function LiveStroke({ points, color, width, kind }: { points: Point[]; color: string; width: number; kind: DrawAnn["kind"] }) {
  // rendered by the parent canvas instead; kept for signature modal reuse
  return null;
}

export function InlineTextEditor({
  ann,
  widthPx,
  widthPt,
  onCommit,
  onCancel,
  onChange,
}: {
  ann: TextAnn;
  widthPx: number;
  widthPt: number;
  onCommit: () => void;
  onCancel: () => void;
  onChange: (text: string) => void;
}) {
  const s = widthPx / widthPt;
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const armed = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
    // the click that created the box can steal focus back — ignore that blur
    const t = setTimeout(() => {
      armed.current = true;
    }, 260);
    return () => clearTimeout(t);
  }, []);
  return (
    <textarea
      ref={ref}
      value={ann.text}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => {
        if (armed.current) onCommit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onCommit();
        }
        e.stopPropagation();
      }}
      spellCheck={false}
      className="absolute z-20 resize-none rounded-[3px] border border-accent bg-white/95 p-0 leading-[1.25] text-black outline-none ring-2 ring-accent/30"
      style={{
        left: ann.rect.x * s,
        top: ann.rect.y * s,
        width: Math.max(80, ann.rect.w * s),
        height: Math.max(28, ann.rect.h * s),
        fontSize: ann.fontSize * s,
        fontFamily: ann.fontKey.includes("times")
          ? "'Times New Roman', serif"
          : ann.fontKey === "courier"
            ? "'Courier New', monospace"
            : "Helvetica, Arial, sans-serif",
        fontWeight: ann.fontKey.includes("bold") ? 700 : 400,
        color: ann.color,
      }}
    />
  );
}

/* --------------------------------------------------------- text measuring */

/** Rough box height for a text annotation, in points. */
export function textBoxHeight(text: string, fontSize: number, widthPt: number, lineHeight = 1.25) {
  const charsPerLine = Math.max(4, Math.floor(widthPt / (fontSize * 0.52)));
  let lines = 0;
  for (const raw of (text || " ").split("\n")) lines += Math.max(1, Math.ceil(raw.length / charsPerLine));
  return Math.max(fontSize * 1.3, lines * fontSize * lineHeight + 4);
}

export function makeTextAnn(
  pageId: string,
  at: Point,
  pageWidthPt: number,
  defaults: { fontSize: number; fontKey: TextAnn["fontKey"]; color: string }
): TextAnn {
  const width = Math.min(280, Math.max(120, pageWidthPt - at.x - 24));
  return {
    id: uid("an"),
    pageId,
    type: "text",
    rect: { x: at.x, y: at.y, w: width, h: defaults.fontSize * 1.5 },
    text: "",
    fontSize: defaults.fontSize,
    fontKey: defaults.fontKey,
    color: defaults.color,
    align: "left",
    opacity: 1,
    lineHeight: 1.25,
  };
}

export function useCanvasMeasure(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  return useCallback(
    (text: string, ann: TextAnn) => {
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return text.length * ann.fontSize * 0.5;
      ctx.font = `${ann.fontKey.includes("bold") ? 700 : 400} ${ann.fontSize}px Helvetica, Arial, sans-serif`;
      return ctx.measureText(text).width;
    },
    [canvasRef]
  );
}

export { drawText };
