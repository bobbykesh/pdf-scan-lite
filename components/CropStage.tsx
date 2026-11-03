"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Move, RotateCcw, Wand2 } from "lucide-react";
import type { Point } from "@/types";
import CropLoupe, { LOUPE_SIZE, type LoupeState } from "./CropLoupe";
import CropThumb from "./CropThumb";

/** TL, TR, BR, BL */
export type Quad = [Point, Point, Point, Point];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function centroid(q: Quad): Point {
  return {
    x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4,
    y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4,
  };
}

function scaleAbout(q: Quad, origin: Point, factor: number): Quad {
  return q.map((p) => ({
    x: origin.x + (p.x - origin.x) * factor,
    y: origin.y + (p.y - origin.y) * factor,
  })) as Quad;
}

/**
 * Keep the quad convex and in-bounds while dragging one corner.
 *
 * Each corner is constrained against its two neighbours only:
 *   TL < TR.x, TL < BL.y | TR > TL.x, TR < BR.y
 *   BR > BL.x, BR > TR.y | BL < BR.x, BL > TL.y
 *
 * (An earlier version compared BL against TL, which pinned it to x = 0 and
 * made the left edge impossible to drag inward.)
 */
function clampCorner(quad: Quad, index: number, next: Point, w: number, h: number): Quad {
  const out = [...quad] as Quad;
  const x = clamp(next.x, 0, w);
  const y = clamp(next.y, 0, h);
  const [tl, tr, br, bl] = out;
  switch (index) {
    case 0:
      out[0] = { x: Math.min(x, tr.x - 2), y: Math.min(y, bl.y - 2) };
      break;
    case 1:
      out[1] = { x: Math.max(x, tl.x + 2), y: Math.min(y, br.y - 2) };
      break;
    case 2:
      out[2] = { x: Math.max(x, bl.x + 2), y: Math.max(y, tr.y + 2) };
      break;
    default:
      out[3] = { x: Math.min(x, br.x - 2), y: Math.max(y, tl.y + 2) };
  }
  return out;
}

/** Edge midpoints, in the same TL,TR,BR,BL order as the corners. */
export type EdgeIndex = 0 | 1 | 2 | 3; // top, right, bottom, left

/**
 * Slide one edge, leaving the opposite edge exactly where it is.
 *
 * The edge is moved by translating its two endpoints along the axis it faces —
 * a horizontal edge only moves in y, a vertical edge only in x. This keeps the
 * quad convex without needing the general corner constraints: the opposite
 * edge is untouched, and the two moving corners cannot cross it because the
 * movement is clamped to stay on their side of it.
 *
 * A quadrilateral whose opposite sides are parallel stays a parallelogram, and
 * that is exactly what a perspective crop of a page is — so dragging an edge
 * does not fight the warp later.
 */
function clampEdge(
  quad: Quad,
  edge: EdgeIndex,
  next: Point,
  w: number,
  h: number,
  /** where the pointer started, in image space — only the facing axis is used */
  start: Point
): Quad {
  const out = [...quad] as Quad;
  const [tl, tr, br, bl] = out;
  const MIN = 8; // never let an edge collapse past the opposite one

  switch (edge) {
    case 0: {
      // top edge: move TL and TR together, in y only
      const y = clamp(next.y, 0, Math.min(br.y, bl.y) - MIN);
      out[0] = { x: tl.x, y };
      out[1] = { x: tr.x, y };
      break;
    }
    case 1: {
      // right edge: TR and BR, in x only
      const x = clamp(next.x, Math.max(tl.x, bl.x) + MIN, w);
      out[1] = { x, y: tr.y };
      out[2] = { x, y: br.y };
      break;
    }
    case 2: {
      // bottom edge: BR and BL, in y only
      const y = clamp(next.y, Math.max(tl.y, tr.y) + MIN, h);
      out[2] = { x: br.x, y };
      out[3] = { x: bl.x, y };
      break;
    }
    default: {
      // left edge: TL and BL, in x only
      const x = clamp(next.x, 0, Math.min(tr.x, br.x) - MIN);
      out[0] = { x, y: tl.y };
      out[3] = { x, y: bl.y };
      break;
    }
  }
  void start;
  return out;
}

/** Midpoint of each edge, in TL,TR,BR,BL order. */
export function edgePoints(q: Quad): [Point, Point, Point, Point] {
  const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return [mid(q[0], q[1]), mid(q[1], q[2]), mid(q[3], q[2]), mid(q[0], q[3])];
}

export default function CropStage({
  /** object URL / data URL of the capture (already filtered for display) */
  preview,
  /** source pixel dimensions of the image behind `preview` */
  width,
  height,
  corners,
  setCorners,
  onAutoCrop,
  onReset,
  busy,
  /** full-resolution (or working-copy) capture; the loupe must not use the preview */
  source,
}: {
  preview: string;
  width: number;
  height: number;
  source?: HTMLCanvasElement | null;
  corners: Quad;
  setCorners: (q: Quad) => void;
  onAutoCrop: () => void;
  onReset: () => void;
  busy?: boolean;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  /** Where the image actually sits inside the 4:3 frame (letterboxed). */
  const [fit, setFit] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const drag = useRef<{
    index: number | "move" | `edge:${EdgeIndex}`;
    start: Point;
    origin: Quad;
  } | null>(null);

  /* --------------- loupe + live thumbnail (follows the finger, not the handle) */
  const [touch, setTouch] = useState<{ x: number; y: number } | null>(null);
  const [loupeFade, setLoupeFade] = useState(0);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showTouch = useCallback((x: number, y: number) => {
    if (fadeTimer.current) {
      clearTimeout(fadeTimer.current);
      fadeTimer.current = null;
    }
    setTouch({ x, y });
    setLoupeFade(1);
  }, []);

  const hideTouchSoon = useCallback(() => {
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    // a beat after release, so the result of the drag is still visible
    fadeTimer.current = setTimeout(() => setLoupeFade(0), 400);
  }, []);

  useEffect(
    () => () => {
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
    },
    []
  );
  const raf = useRef(0);
  const pending = useRef<Quad | null>(null);

  /* -------------------------------------------------- responsive sizing */
  useLayoutEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      // Fit the 4:3 viewfinder inside the available space.
      const maxW = rect.width;
      const maxH = rect.height;
      let w = maxW;
      let h = (w * 3) / 4;
      if (h > maxH) {
        h = maxH;
        w = (h * 4) / 3;
      }
      const bw = Math.max(1, Math.floor(w));
      const bh = Math.max(1, Math.floor(h));
      setBox({ w: bw, h: bh });

      // contain-fit the source image inside that frame
      const scale = Math.min(bw / width, bh / height);
      const iw = Math.max(1, Math.round(width * scale));
      const ih = Math.max(1, Math.round(height * scale));
      setFit({ x: Math.round((bw - iw) / 2), y: Math.round((bh - ih) / 2), w: iw, h: ih });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ------------------------------------------------------- drag handling */
  const toImage = useCallback(
    (clientX: number, clientY: number): Point => {
      const el = shellRef.current;
      if (!el) return { x: 0, y: 0 };
      const rect = el.getBoundingClientRect();
      // The 4:3 frame is centred inside the shell, and the image is
      // letterboxed inside that frame — both offsets must be accounted for or
      // the corner handles drift away from the page.
      const ox = rect.left + (rect.width - box.w) / 2 + fit.x;
      const oy = rect.top + (rect.height - box.h) / 2 + fit.y;
      return {
        x: clamp(((clientX - ox) / Math.max(1, fit.w)) * width, 0, width),
        y: clamp(((clientY - oy) / Math.max(1, fit.h)) * height, 0, height),
      };
    },
    [box.h, box.w, fit.h, fit.w, fit.x, fit.y, height, width]
  );

  /** Coalesce pointer moves into one state update per animation frame. */
  const schedule = useCallback(
    (q: Quad) => {
      pending.current = q;
      if (raf.current) return;
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        if (pending.current) setCorners(pending.current);
      });
    },
    [setCorners]
  );

  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    },
    []
  );

  /** Pointer position relative to the crop frame, for placing the loupe. */
  const toFrame = useCallback((clientX: number, clientY: number) => {
    const el = shellRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const left = rect.left + (rect.width - box.w) / 2;
    const top = rect.top + (rect.height - box.h) / 2;
    return { x: clientX - left, y: clientY - top };
  }, [box.h, box.w]);

  const begin =
    (index: number | "move" | `edge:${EdgeIndex}`) => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { index, start: toImage(e.clientX, e.clientY), origin: corners };
      const f = toFrame(e.clientX, e.clientY);
      showTouch(f.x, f.y); // the loupe appears on touch, not on movement
      if (navigator.vibrate) navigator.vibrate(8);
    };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    e.preventDefault();
    const p = toImage(e.clientX, e.clientY);
    const f = toFrame(e.clientX, e.clientY);
    showTouch(f.x, f.y);

    if (d.index === "move") {
      // Translate the whole quad, clamped so no corner leaves the image.
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      const xs = d.origin.map((c) => c.x);
      const ys = d.origin.map((c) => c.y);
      const ddx = Math.max(-Math.min(...xs), Math.min(width - Math.max(...xs), dx));
      const ddy = Math.max(-Math.min(...ys), Math.min(height - Math.max(...ys), dy));
      schedule(d.origin.map((c) => ({ x: c.x + ddx, y: c.y + ddy })) as Quad);
      return;
    }

    if (typeof d.index === "string" && d.index.startsWith("edge:")) {
      const edge = Number(d.index.slice(5)) as EdgeIndex;
      schedule(clampEdge(d.origin, edge, p, width, height, d.start));
      return;
    }

    if (typeof d.index === "number") {
      schedule(clampCorner(d.origin, d.index, p, width, height));
    }
  };

  const end = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    pending.current = null;
    hideTouchSoon();
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  /* --------------------------------------------------------------- render */
  const px = (v: number, total: number) => `${(v / total) * 100}%`;
  const centre = centroid(corners);

  const edges = useMemo(() => edgePoints(corners), [corners]);

  /** css px per source px, as currently displayed */
  const displayScale = fit.w / Math.max(1, width);

  /*
   * Where the loupe goes: offset from the finger so it is never under it and
   * never covers the point being placed. It flips to the other side near the
   * frame edges, so it can never be half off-screen.
   */
  const loupe: LoupeState | null = touch
    ? (() => {
        const gap = 22;
        const half = LOUPE_SIZE / 2;
        const margin = 2;
        // Prefer right/below the finger, flip when there is no room, then
        // clamp so the ring can never be clipped by the frame.
        const rightFits = touch.x + gap + LOUPE_SIZE < box.w - margin;
        const leftFits = touch.x - gap - LOUPE_SIZE > margin;
        const downFits = touch.y + gap + LOUPE_SIZE < box.h - margin;
        const upFits = touch.y - gap - LOUPE_SIZE > margin;

        let cx = rightFits ? touch.x + gap + half : touch.x - gap - half;
        if (!rightFits && !leftFits) cx = box.w - half - margin;
        cx = Math.min(box.w - half - margin, Math.max(half + margin, cx));

        let cy = downFits ? touch.y + gap + half : touch.y - gap - half;
        if (!downFits && !upFits) cy = box.h - half - margin;
        cy = Math.min(box.h - half - margin, Math.max(half + margin, cy));

        return { x: touch.x, y: touch.y, cx, cy, opacity: loupeFade };
      })()
    : null;

  /*
   * The result card sits opposite the loupe, so the two never overlap: the
   * loupe is there to place a corner, the card to judge the whole crop.
   */
  const THUMB_BOX = { w: 116, h: 104 };
  const thumbSide = touch
    ? {
        left: loupe && loupe.cx < box.w / 2 ? Math.max(6, box.w - THUMB_BOX.w - 6) : 6,
        top: loupe && loupe.cy < box.h / 2 ? Math.max(6, box.h - THUMB_BOX.h - 6) : 6,
      }
    : { left: 6, top: 6 };

  return (
    <div ref={shellRef} className="relative flex h-full w-full items-center justify-center">
      <div
        className="relative touch-none select-none overflow-hidden rounded-xl border border-line2 bg-black shadow-[0_0_0_1px_rgba(255,255,255,0.04)]"
        style={{ width: box.w, height: box.h }}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {/* The whole frame is draggable, which is what makes this feel responsive. */}
        <div className="absolute inset-0" onPointerDown={begin("move")} onPointerMove={move} onPointerUp={end}>
          <img
            src={preview}
            alt="Captured page"
            className="pointer-events-none absolute max-w-none select-none"
            style={{ left: fit.x, top: fit.y, width: fit.w, height: fit.h }}
            draggable={false}
          />
        </div>

        {/* Dim everything outside the selection. */}
        <svg
          className="pointer-events-none absolute"
          style={{ left: fit.x, top: fit.y, width: fit.w, height: fit.h }}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
        >
          <defs>
            <mask id="crop-mask">
              <rect x="0" y="0" width={width} height={height} fill="white" />
              <polygon points={corners.map((c) => `${c.x},${c.y}`).join(" ")} fill="black" />
            </mask>
          </defs>
          <rect
            x="0"
            y="0"
            width={width}
            height={height}
            fill="rgba(4,6,12,0.55)"
            mask="url(#crop-mask)"
          />
          <polygon
            points={corners.map((c) => `${c.x},${c.y}`).join(" ")}
            fill="none"
            stroke="#8b95ff"
            vectorEffect="non-scaling-stroke"
            strokeWidth={2}
            strokeLinejoin="round"
          />
        </svg>

        {/* Quadrant guides inside the selection. */}
        <svg
          className="pointer-events-none absolute opacity-40"
          style={{ left: fit.x, top: fit.y, width: fit.w, height: fit.h }}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
        >
          {(() => {
            const lerp = (a: Point, b: Point, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
            const segs: [Point, Point][] = [];
            for (const t of [1 / 3, 2 / 3]) {
              segs.push([lerp(corners[0], corners[1], t), lerp(corners[3], corners[2], t)]);
              segs.push([lerp(corners[0], corners[3], t), lerp(corners[1], corners[2], t)]);
            }
            return segs.map(([a, b], i) => (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="#ffffff"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                strokeDasharray="4 6"
              />
            ));
          })()}
        </svg>

        {/* Corner handles: 44px hit area, 22px visual — usable with a thumb. */}
        {corners.map((c, i) => (
          <div
            key={i}
            role="slider"
            tabIndex={0}
            aria-label={["Top left corner", "Top right corner", "Bottom right corner", "Bottom left corner"][i]}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((c.x / width) * 100)}
            aria-valuetext={`${Math.round((c.x / width) * 100)}% across, ${Math.round((c.y / height) * 100)}% down`}
            onPointerDown={begin(i)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 20 : 5;
              const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
              const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
              if (!dx && !dy) return;
              e.preventDefault();
              setCorners(
                clampCorner(corners, i, { x: c.x + dx, y: c.y + dy }, width, height)
              );
            }}
            className="absolute z-20 grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none place-items-center rounded-full active:cursor-grabbing"
            style={{ left: fit.x + (c.x / width) * fit.w, top: fit.y + (c.y / height) * fit.h }}
          >
            <span className="grid h-[22px] w-[22px] place-items-center rounded-full border-[3px] border-white bg-accent shadow-[0_2px_10px_rgba(0,0,0,0.55)] transition-transform duration-100 ease-out active:scale-125" />
          </div>
        ))}

        {/* Move handle in the middle. */}
        <div
          onPointerDown={begin("move")}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          className="absolute z-10 grid h-12 w-12 -translate-x-1/2 -translate-y-1/2 cursor-move touch-none place-items-center rounded-full border border-white/25 bg-black/45 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/60"
          style={{ left: fit.x + (centre.x / width) * fit.w, top: fit.y + (centre.y / height) * fit.h }}
          title="Drag to move the whole crop"
        >
          <Move size={18} />
        </div>

        {/* Edge handles: slim pills on each side, draggable on their own. */}
        {edges.map((mid, i) => {
          const horizontal = i === 0 || i === 2; // top/bottom move in y
          return (
            <div
              key={`edge-${i}`}
              role="slider"
              tabIndex={0}
              aria-label={["Top edge", "Right edge", "Bottom edge", "Left edge"][i]}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(((horizontal ? mid.y / height : mid.x / width) * 100))}
              onPointerDown={begin(`edge:${i}` as `edge:${EdgeIndex}`)}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
              className={`absolute z-20 grid touch-none place-items-center ${
                horizontal ? "h-11 w-12 cursor-ns-resize" : "h-12 w-11 cursor-ew-resize"
              } -translate-x-1/2 -translate-y-1/2`}
              style={{ left: fit.x + (mid.x / width) * fit.w, top: fit.y + (mid.y / height) * fit.h }}
            >
              {/* visible pill: 34x10 (or rotated), the familiar house shape */}
              <span
                className={`rounded-full border-[3px] border-white bg-accent shadow-[0_2px_10px_rgba(0,0,0,0.55)] transition-transform duration-100 ease-out active:scale-110 ${
                  horizontal ? "h-2 w-10" : "h-10 w-2"
                }`}
              />
            </div>
          );
        })}

        {/* Live straightened result, for judging the crop as a whole. */}
        <CropThumb
          quad={corners}
          source={source ?? null}
          visible={!!touch && loupeFade > 0}
          side={thumbSide}
        />

        {/* The magnifier that follows the finger. */}
        {loupe ? (
          <CropLoupe
            state={loupe}
            source={source ?? null}
            displayScale={displayScale}
            origin={{ x: fit.x, y: fit.y }}
          />
        ) : null}

        {busy ? (
          <div className="absolute inset-0 z-30 grid place-items-center bg-black/55 backdrop-blur-[2px]">
            <div className="flex items-center gap-3 rounded-full bg-black/70 px-4 py-2 text-sm text-white">
              <RotateCcw size={16} className="animate-spin" /> Cropping…
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
