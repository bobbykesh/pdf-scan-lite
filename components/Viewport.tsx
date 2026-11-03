"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Maximize2,
  Minus,
  Plus,
  RotateCw,
  ScanText,
  Trash2,
  Wand2,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { useShell } from "./AppShell";
import { OcrLayer, PDFCanvas, InlineTextEditor, textBoxHeight } from "./PageView";
import { displaySize, clamp, uid } from "@/lib/utils";
import { sampleBorderColor } from "@/lib/imaging";
import type { Annotation, DrawAnn, OcrWord, Point, Rect, TextAnn } from "@/types";
import { IconButton, Segmented } from "./ui";

type Drag =
  | { kind: "draw"; id: string; start: Point; last: Point }
  | { kind: "pen"; id: string }
  | { kind: "marquee"; id: string; start: Point }
  | null;

export default function Viewport({ onEditWord }: { onEditWord: (word: OcrWord, pageId: string) => void }) {
  const store = useStore();
  const shell = useShell();
  const { currentPage: page, currentIndex, pages, tool, tools } = store;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgFileRef = useRef<HTMLInputElement | null>(null);
  const drag = useRef<Drag>(null);
  const pointerStart = useRef<Point | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const padRef = useRef<HTMLDivElement | null>(null);
  /** Bumped whenever the page area is re-measured, to recompute the fit. */
  const [layoutTick, setLayoutTick] = useState(0);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [imgPoint, setImgPoint] = useState<Point | null>(null);
  const [, setRenderTick] = useState(0);
  const [, forceRedraw] = useState(0);

  const pageAnnos = useMemo(
    () => (page ? store.annotations[page.id] ?? [] : []),
    [store.annotations, page]
  );

  const editingAnn = useMemo(
    () => pageAnnos.find((a): a is TextAnn => a.id === store.editingTextId && a.type === "text") ?? null,
    [pageAnnos, store.editingTextId]
  );

  /* ------------------------------------------------------------- geometry */

  useEffect(() => {
    const el = scrollRef.current;
    const pad = padRef.current;
    if (!el) return;
    const bump = () => setLayoutTick((t) => t + 1);
    bump();
    const ro = new ResizeObserver(bump);
    ro.observe(el);
    if (pad) ro.observe(pad); // the tool rail's reserved height lives in this padding
    const onOrient = () => bump();
    window.addEventListener("orientationchange", onOrient);
    window.addEventListener("resize", onOrient);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", onOrient);
      window.removeEventListener("resize", onOrient);
    };
  }, []);

  const ptSize = page ? displaySize(page) : { w: 595, h: 842 };

  /**
   * Fit-to-view uses the *measured* size of the page area.
   *
   * This used to subtract a guessed 190px of chrome from `window.innerHeight`.
   * On a phone that guess is far too small (top bar + page strip + tool rail +
   * the bottom action bar are much taller), so a page was laid out taller than
   * its container and the bottom got clipped — most obvious on landscape pages
   * and when the phone itself is held sideways.
   *
   * The values are read from the DOM each time the area is re-measured
   * (`layoutTick`), so the padding that reserves room for the floating tool
   * rail is always the current one.
   */
  const { widthPx, heightPx } = useMemo(() => {
    const el = scrollRef.current;
    const pad = padRef.current;
    const px = (v: string) => parseFloat(v) || 0;
    const cs = pad ? getComputedStyle(pad) : null;
    const cw = el ? el.clientWidth - (cs ? px(cs.paddingLeft) + px(cs.paddingRight) : 0) : 900;
    const ch = el ? el.clientHeight - (cs ? px(cs.paddingTop) + px(cs.paddingBottom) : 0) : 600;
    const availW = Math.max(120, cw);
    const availH = Math.max(120, ch);
    const fitScale = Math.min(availW / ptSize.w, availH / ptSize.h);
    const scale = fit ? fitScale : fitScale * zoom;
    return {
      widthPx: Math.max(80, Math.round(ptSize.w * scale)),
      heightPx: Math.max(80, Math.round(ptSize.h * scale)),
    };
    // layoutTick re-reads the DOM after resizes / orientation changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutTick, ptSize.w, ptSize.h, fit, zoom]);

  // reset zoom when the page changes
  useEffect(() => {
    setFit(true);
    setZoom(1);
  }, [page?.id]);

  /* -------------------------------------------------------- helper: coords */

  const toPt = useCallback(
    (clientX: number, clientY: number): Point => {
      const el = stageRef.current;
      if (!el) return { x: 0, y: 0 };
      const r = el.getBoundingClientRect();
      const s = widthPx / ptSize.w;
      return {
        x: clamp((clientX - r.left) / s, 0, ptSize.w),
        y: clamp((clientY - r.top) / s, 0, ptSize.h),
      };
    },
    [widthPx, ptSize.w, ptSize.h]
  );

  /* --------------------------------------------------------------- drawing */

  const redraw = useCallback(() => {
    const canvas = drawCanvasRef.current;
    const live = drag.current;
    if (!canvas || !live) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const s = canvas.width / ptSize.w;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (live.kind === "marquee") {
      const a = live.start;
      const b = pointerStart.current ?? live.start;
      const r = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
      ctx.fillStyle = tools.eraseMode === "smart" ? store.tools.eraseColor : "rgba(120,130,150,.28)";
      ctx.fillRect(r.x * s, r.y * s, Math.max(1, r.w * s), Math.max(1, r.h * s));
      ctx.strokeStyle = "#8b95ff";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(r.x * s, r.y * s, Math.max(1, r.w * s), Math.max(1, r.h * s));
    } else {
      const ann = pageAnnos.find((a) => a.id === live.id);
      if (ann && ann.type === "draw") {
        ctx.globalAlpha = ann.opacity ?? 1;
        ctx.globalCompositeOperation = ann.kind === "highlight" ? "multiply" : "source-over";
        ctx.strokeStyle = ann.color;
        ctx.fillStyle = ann.color;
        ctx.lineWidth = Math.max(1, ann.width * s);
        if (ann.points.length === 1) {
          ctx.beginPath();
          ctx.arc(ann.points[0].x * s, ann.points[0].y * s, ctx.lineWidth / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(ann.points[0].x * s, ann.points[0].y * s);
          for (let i = 1; i < ann.points.length - 1; i++) {
            const a = ann.points[i];
            const b = ann.points[i + 1];
            ctx.quadraticCurveTo(a.x * s, a.y * s, ((a.x + b.x) / 2) * s, ((a.y + b.y) / 2) * s);
          }
          const last = ann.points[ann.points.length - 1];
          ctx.lineTo(last.x * s, last.y * s);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }, [pageAnnos, ptSize.w, tools.eraseMode, store.tools.eraseColor]);

  const clearOverlay = () => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
  };

  /* -------------------------------------------------------------- pointers */

  const onPointerDown = (e: React.PointerEvent) => {
    if (!page) return;
    if (store.editingTextId) return;
    const pt = toPt(e.clientX, e.clientY);
    pointerStart.current = pt;

    // start eraser as a draggable rectangle (brush strokes are for the pen tools)
    if (tool === "erase") {
      const ann: Annotation = {
        id: uid("an"),
        pageId: page.id,
        type: "redact",
        rect: { x: pt.x, y: pt.y, w: 0, h: 0 },
        color: store.tools.eraseMode === "smart" ? store.tools.eraseColor : "#ffffff",
      };
      store.addAnnotation(ann);
      drag.current = { kind: "marquee", id: ann.id, start: pt };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }

    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    if (tool === "select") {
      const hit = hitTest(pt, pageAnnos);
      store.setSelectedId(hit?.id ?? null);
      return;
    }

    if (tool === "text") {
      const defaults = { fontSize: store.tools.fontSize, fontKey: store.tools.fontKey, color: store.tools.color };
      const ann: TextAnn = {
        id: uid("an"),
        pageId: page.id,
        type: "text",
        rect: { x: Math.min(pt.x, ptSize.w - 140), y: pt.y, w: Math.min(260, ptSize.w - pt.x - 16), h: store.tools.fontSize * 1.5 },
        text: "",
        fontSize: defaults.fontSize,
        fontKey: defaults.fontKey,
        color: defaults.color,
        align: "left",
        opacity: 1,
        lineHeight: 1.25,
      };
      store.addAnnotation(ann);
      store.setEditingTextId(ann.id);
      store.setTool("select");
      return;
    }

    if (tool === "pen" || tool === "marker") {
      const kind: DrawAnn["kind"] = tool === "pen" ? "pen" : "highlight";
      const width = tool === "marker" ? store.tools.markerWidth : store.tools.penWidth;
      let color = store.tools.color;
      if (tool === "marker") color = store.tools.highlightColor;
      const ann: DrawAnn = {
        id: uid("an"),
        pageId: page.id,
        type: "draw",
        kind,
        rect: { x: pt.x, y: pt.y, w: 0, h: 0 },
        points: [pt],
        color,
        width,
        opacity: tool === "marker" ? 0.38 : 1,
      };
      store.addAnnotation(ann);
      drag.current = { kind: "pen", id: ann.id };
      redraw();
      return;
    }

    if (tool === "sign" && store.tools.signatureDataUrl) {
      const img = new Image();
      img.onload = () => {
        const w = Math.min(ptSize.w * 0.36, 220);
        const h = (img.naturalHeight / img.naturalWidth) * w;
        const ann: Annotation = {
          id: uid("an"),
          pageId: page.id,
          type: "image",
          rect: { x: clamp(pt.x - w / 2, 0, ptSize.w - w), y: clamp(pt.y - h / 2, 0, ptSize.h - h), w, h },
          dataUrl: store.tools.signatureDataUrl!,
          opacity: 1,
        };
        store.addAnnotation(ann);
        store.setSelectedId(ann.id);
        store.setTool("select");
      };
      img.src = store.tools.signatureDataUrl;
      return;
    }

    if (tool === "image") {
      setImgPoint(pt);
      imgFileRef.current?.click();
      return;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const live = drag.current;
    if (!live) return;
    const pt = toPt(e.clientX, e.clientY);
    pointerStart.current = pt;
    if (live.kind === "marquee") {
      const a = live.start;
      store.updateAnnotation(live.id, {
        rect: {
          x: Math.min(a.x, pt.x),
          y: Math.min(a.y, pt.y),
          w: Math.abs(pt.x - a.x),
          h: Math.abs(pt.y - a.y),
        },
      } as Partial<Annotation>);
      redraw();
      return;
    }
    if (live.kind === "pen") {
      store.setAnnotations((prev) => ({
        ...prev,
        [page!.id]: (prev[page!.id] ?? []).map((a) =>
          a.id === live.id && a.type === "draw" ? { ...a, points: [...a.points, pt] } : a
        ),
      }));
    }
    redraw();
  };

  const onPointerUp = async () => {
    const live = drag.current;
    drag.current = null;
    if (!live || !page) {
      clearOverlay();
      forceRedraw((n) => n + 1);
      return;
    }
    if (live.kind === "marquee") {
      const ann = store.annotations[page.id]?.find((a) => a.id === live.id);
      if (!ann || ann.type !== "redact" || ann.rect.w < 2 || ann.rect.h < 2) {
        store.removeAnnotation(live.id);
      } else if (store.tools.eraseMode === "smart") {
        await matchSmartErase(page.id, ann.id, ann.rect);
      }
      clearOverlay();
      store.setTool("select");
      store.setSelectedId(live.id);
      forceRedraw((n) => n + 1);
      return;
    }
    if (live.kind === "pen") {
      const ann = store.annotations[page.id]?.find((a) => a.id === live.id);
      if (ann && ann.type === "draw") {
        const xs = ann.points.map((p) => p.x);
        const ys = ann.points.map((p) => p.y);
        const rect = {
          x: Math.min(...xs) - ann.width,
          y: Math.min(...ys) - ann.width,
          w: Math.max(...xs) - Math.min(...xs) + ann.width * 2,
          h: Math.max(...ys) - Math.min(...ys) + ann.width * 2,
        };
        store.updateAnnotation(ann.id, { rect } as Partial<Annotation>);
        if (ann.kind === "erase" && store.tools.eraseMode === "smart") {
          await matchSmartErase(page.id, ann.id, rect);
        }
      }
      clearOverlay();
      forceRedraw((n) => n + 1);
    }
  };

  /** sample the page pixels around the eraser stroke so it blends in */
  const matchSmartErase = async (pageId: string, annId: string, rect: Rect) => {
    try {
      const base = imgCanvasRef.current;
      if (!base) return;
      const zoomK = base.width / widthPx;
      const color = sampleBorderColor(base, {
        x: rect.x * (widthPx / ptSize.w) * zoomK,
        y: rect.y * (widthPx / ptSize.w) * zoomK,
        w: rect.w * (widthPx / ptSize.w) * zoomK,
        h: rect.h * (widthPx / ptSize.w) * zoomK,
      });
      store.updateAnnotation(annId, { color } as Partial<Annotation>);
      void pageId;
    } catch {
      /* keep white */
    }
  };

  /* ---------------------------------------------------------- keyboard ops */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable) return;
      if ((e.key === "Delete" || e.key === "Backspace") && store.selectedId) {
        e.preventDefault();
        store.removeAnnotation(store.selectedId);
      }
      if (e.key === "Escape") {
        store.setSelectedId(null);
        store.setEditingTextId(null);
        if (store.tool !== "select") store.setTool("select");
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && store.selectedId) {
        e.preventDefault();
        store.duplicateAnnotation(store.selectedId);
      }
      if (e.key === "ArrowRight" && !e.metaKey) store.goTo(store.currentIndex + 1);
      if (e.key === "ArrowLeft" && !e.metaKey) store.goTo(store.currentIndex - 1);
      const vk: Record<string, typeof store.tool> = { v: "select", t: "text", p: "pen", h: "marker", e: "erase" };
      if (vk[e.key.toLowerCase()] && !e.metaKey && !e.ctrlKey) store.setTool(vk[e.key.toLowerCase()]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  /* ---------------------------------------------------------------- image */

  const placeImage = (file: File) => {
    const pt = imgPoint ?? { x: ptSize.w / 2, y: ptSize.h / 2 };
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const w = Math.min(ptSize.w * 0.5, 300);
        const h = (img.naturalHeight / img.naturalWidth) * w;
        const ann: Annotation = {
          id: uid("an"),
          pageId: page!.id,
          type: "image",
          rect: { x: clamp(pt.x - w / 2, 0, Math.max(0, ptSize.w - w)), y: clamp(pt.y - h / 2, 0, Math.max(0, ptSize.h - h)), w, h },
          dataUrl: String(reader.result),
          opacity: 1,
        };
        store.addAnnotation(ann);
        store.setSelectedId(ann.id);
        store.setTool("select");
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
    setImgPoint(null);
  };

  /* ---------------------------------------------------------------- render */

  if (!page) {
    return <div className="grid flex-1 place-items-center text-sm text-muted">No page selected</div>;
  }

  const selAnn = pageAnnos.find((a) => a.id === store.selectedId);
  // tapping words edits them only in Select mode, so the Text tool can always write freely
  const ocrActive = !!page.ocr?.words?.length && tool === "select" && !store.editingTextId;
  const s = widthPx / ptSize.w;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <input
        ref={imgFileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) placeImage(f);
        }}
      />

      {/* context bar */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel/60 px-3 text-[11.5px] text-muted">
        <span className="tabular">
          Page {currentIndex + 1} <span className="text-dim">of {pages.length}</span>
        </span>
        <span className="hidden text-dim sm:inline">·</span>
        <span className="tabular hidden sm:inline">
          {Math.round(ptSize.w)} × {Math.round(ptSize.h)} pt
        </span>
        {page.ocr?.words?.length ? (
          <span className="flex items-center gap-1 rounded bg-good/15 px-1.5 py-0.5 text-[10.5px] font-medium text-good">
            <ScanText size={10} /> {page.ocr.words.filter((w) => w.conf !== -1).length} words
          </span>
        ) : null}
        {page.ocrState === "running" ? <span className="text-accent">recognising…</span> : null}
        <div className="ml-auto flex items-center gap-1">
          {selAnn ? (
            <div className="mr-1 flex items-center gap-0.5 rounded-md border border-line bg-panel2 px-0.5">
              <IconButton label="Duplicate (⌘D)" className="h-7 w-7" onClick={() => store.duplicateAnnotation(selAnn.id)}>
                <Copy size={13} />
              </IconButton>
              {selAnn.type === "draw" || selAnn.type === "redact" ? (
                <IconButton label="Delete" className="h-7 w-7 text-bad hover:bg-bad/15" onClick={() => store.removeAnnotation(selAnn.id)}>
                  <Trash2 size={13} />
                </IconButton>
              ) : (
                <IconButton label="Delete (Del)" className="h-7 w-7 text-bad hover:bg-bad/15" onClick={() => store.removeAnnotation(selAnn.id)}>
                  <Trash2 size={13} />
                </IconButton>
              )}
            </div>
          ) : null}
          <IconButton label="Previous page (←)" className="h-7 w-7" onClick={() => store.goTo(currentIndex - 1)} disabled={currentIndex <= 0}>
            <ChevronLeft size={15} />
          </IconButton>
          <IconButton label="Next page (→)" className="h-7 w-7" onClick={() => store.goTo(currentIndex + 1)} disabled={currentIndex >= pages.length - 1}>
            <ChevronRight size={15} />
          </IconButton>
          <div className="mx-1 h-5 w-px bg-line" />
          <IconButton label="Zoom out" className="h-7 w-7" onClick={() => { setFit(false); setZoom((z) => clamp(z * 0.85, 0.5, 3)); }}>
            <Minus size={14} />
          </IconButton>
          <button
            className="tabular rounded px-1.5 py-1 text-[11px] hover:bg-panel3"
            onClick={() => { setFit(true); setZoom(1); }}
            title="Fit to screen"
          >
            {fit ? "Fit" : `${Math.round(zoom * 100)}%`}
          </button>
          <IconButton label="Zoom in" className="h-7 w-7" onClick={() => { setFit(false); setZoom((z) => clamp(z * 1.18, 0.5, 3)); }}>
            <Plus size={14} />
          </IconButton>
          <IconButton label="Full width" className="h-7 w-7" onClick={() => setFit(true)}>
            <Maximize2 size={13} />
          </IconButton>
        </div>
      </div>

      {/* canvas area */}
      <div
        ref={scrollRef}
        className="scroll-thin relative flex-1 overflow-auto"
        style={{ background: "radial-gradient(1200px 600px at 50% -10%, #16203300, #0a0d14 70%), #0a0d14" }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) placeImage(f);
        }}
      >
        <div
          ref={padRef}
          className="flex min-h-full items-center justify-center p-4 pb-[calc(var(--rail-h,88px)+1rem)] lg:items-start lg:p-6 lg:pb-[calc(var(--rail-h,88px)+1.5rem)]"
          onClick={() => tool === "select" && store.setSelectedId(null)}
        >
          <div
            ref={stageRef}
            className="paper-shadow relative select-none"
            style={{
              width: widthPx,
              height: heightPx,
              touchAction: "none",
              cursor: tool === "select" ? "default" : tool === "text" ? "text" : "crosshair",
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <div className="relative overflow-hidden bg-white">
              <PDFCanvas
                meta={page}
                widthPx={widthPx}
                heightPx={heightPx}
                annotations={pageAnnos}
                excludeIds={store.editingTextId ? [store.editingTextId] : []}
                onReady={() => setRenderTick((t) => t + 1)}
              />

              {/* live pen overlay */}
              <canvas
                ref={drawCanvasRef}
                width={Math.round(widthPx * Math.min(2, window.devicePixelRatio || 1))}
                height={Math.round(heightPx * Math.min(2, window.devicePixelRatio || 1))}
                className="pointer-events-none absolute inset-0"
                style={{ width: widthPx, height: heightPx }}
              />

              {page.ocr?.words?.length ? (
                <OcrLayer
                  pageId={page.id}
                  words={page.ocr.words}
                  active={ocrActive}
                  widthPx={widthPx}
                  heightPx={heightPx}
                  pageWidthPt={ptSize.w}
                  onEdit={(w) => onEditWord(w, page.id)}
                />
              ) : null}

              {/* text editing */}
              {editingAnn ? (
                <InlineTextEditor
                  key={editingAnn.id}
                  ann={editingAnn}
                  widthPx={widthPx}
                  widthPt={ptSize.w}
                  onChange={(text) =>
                    store.updateAnnotation(editingAnn.id, {
                      text,
                      rect: { ...editingAnn.rect, h: textBoxHeight(text, editingAnn.fontSize, editingAnn.rect.w, editingAnn.lineHeight) },
                    } as Partial<Annotation>)
                  }
                  onCommit={() => {
                    const latest = store.annotations[page.id]?.find((a) => a.id === editingAnn.id) as TextAnn | undefined;
                    if (!latest || !latest.text.trim()) {
                      if (latest) store.removeAnnotation(latest.id);
                    } else {
                      store.updateAnnotation(latest.id, {
                        rect: { ...latest.rect, h: textBoxHeight(latest.text, latest.fontSize, latest.rect.w, latest.lineHeight) },
                      } as Partial<Annotation>);
                    }
                    store.setEditingTextId(null);
                  }}
                  onCancel={() => {
                    const latest = store.annotations[page.id]?.find((a) => a.id === editingAnn.id) as TextAnn | undefined;
                    if (latest && !latest.text.trim()) store.removeAnnotation(latest.id);
                    store.setEditingTextId(null);
                  }}
                />
              ) : null}

              {/* selection affordance for non-text items */}
              {selAnn && (selAnn.type === "draw" || selAnn.type === "redact") ? (
                <div
                  className="pointer-events-none absolute border border-dashed border-accent/70"
                  style={{
                    left: selAnn.rect.x * s,
                    top: selAnn.rect.y * s,
                    width: Math.max(2, selAnn.rect.w * s),
                    height: Math.max(2, selAnn.rect.h * s),
                  }}
                />
              ) : null}
            </div>

            {/* move/resize handles for text & images live in an HTML layer above */}
            <SelectionLayer
              annotations={pageAnnos.filter((a) => a.type === "text" || a.type === "image")}
              selectedId={store.selectedId}
              widthPx={widthPx}
              widthPt={ptSize.w}
              enabled={tool === "select"}
              editing={!!store.editingTextId}
              onSelect={(id) => store.setSelectedId(id)}
              onChange={(id, rect) => store.updateAnnotation(id, { rect } as Partial<Annotation>)}
            />

            {tool === "sign" && !store.tools.signatureDataUrl ? (
              <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/25">
                <div className="rounded-xl bg-panel/95 px-4 py-3 text-center text-[12.5px] text-ink shadow-xl">
                  <Wand2 className="mx-auto mb-1.5 text-accent" size={18} />
                  Draw or upload a signature first
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Move / resize handles for text boxes and stamped images. */
function SelectionLayer({
  annotations,
  selectedId,
  widthPx,
  widthPt,
  enabled,
  editing,
  onSelect,
  onChange,
}: {
  annotations: Annotation[];
  selectedId: string | null;
  widthPx: number;
  widthPt: number;
  enabled: boolean;
  editing: boolean;
  onSelect: (id: string) => void;
  onChange: (id: string, rect: Rect) => void;
}) {
  const s = widthPx / widthPt;
  const drag = useRef<{ id: string; mode: "move" | "resize"; corner: number; sx: number; sy: number; rect: Rect } | null>(null);
  const [active, setActive] = useState<string | null>(null);

  const start = (e: React.PointerEvent, a: Annotation & { rect: Rect }, mode: "move" | "resize", corner = 2) => {
    if (!enabled) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onSelect(a.id);
    setActive(a.id);
    drag.current = { id: a.id, mode, corner, sx: e.clientX, sy: e.clientY, rect: { ...a.rect } };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / s;
    const dy = (e.clientY - d.sy) / s;
    if (d.mode === "move") {
      onChange(d.id, { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy });
    } else {
      const minW = 30;
      const minH = 18;
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
    setActive(null);
  };

  return (
    <div className="absolute inset-0" style={{ pointerEvents: "none" }}>
      {annotations.map((a) => {
        const rect = (a as TextAnn).rect;
        if (!rect) return null;
        const sel = selectedId === a.id || active === a.id;
        return (
          <div
            key={a.id}
            onPointerDown={(e) => start(e, a as Annotation & { rect: Rect }, "move")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            className={sel ? "sel-ring" : "hover:ring-1 hover:ring-accent/40"}
            style={{
              position: "absolute",
              left: rect.x * s,
              top: rect.y * s,
              width: rect.w * s,
              height: rect.h * s,
              cursor: enabled ? "move" : "default",
              touchAction: "none",
              pointerEvents: enabled && !editing ? "auto" : "none",
            }}
          >
            {sel
              ? [
                  [0, 0],
                  [1, 0],
                  [2, 2],
                  [0, 2],
                ].map(([cx, cy], i) => (
                  <span
                    key={i}
                    onPointerDown={(e) => start(e, a as Annotation & { rect: Rect }, "resize", i)}
                    onPointerMove={move}
                    onPointerUp={end}
                    className="absolute h-2.5 w-2.5 rounded-[2px] border border-white bg-accent shadow"
                    style={{
                      left: cx === 0 ? -5 : cx === 1 ? undefined : undefined,
                      right: cx === 1 ? -5 : cx === 2 ? -5 : undefined,
                      top: cy === 0 ? -5 : cy === 2 ? -5 : undefined,
                      bottom: cy === 2 ? -5 : undefined,
                      cursor: cx === 1 ? "nesw-resize" : "nwse-resize",
                    }}
                  />
                ))
              : null}
          </div>
        );
      })}
    </div>
  );
}

function hitTest(pt: Point, annos: Annotation[]): Annotation | null {
  for (let i = annos.length - 1; i >= 0; i--) {
    const a = annos[i];
    const r = a.type === "draw" ? a.rect : a.rect;
    const pad = a.type === "draw" ? 4 : 0;
    if (pt.x >= r.x - pad && pt.x <= r.x + r.w + pad && pt.y >= r.y - pad && pt.y <= r.y + r.h + pad) return a;
  }
  return null;
}
