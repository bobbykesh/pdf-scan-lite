"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Move, RotateCcw, Wand2 } from "lucide-react";
import type { Point } from "@/types";

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
}: {
  preview: string;
  width: number;
  height: number;
  corners: Quad;
  setCorners: (q: Quad) => void;
  onAutoCrop: () => void;
  onReset: () => void;
  busy?: boolean;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const drag = useRef<{ index: number | "move"; start: Point; origin: Quad } | null>(null);
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
      setBox({ w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(h)) });
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
      // The 4:3 frame is centred inside the shell.
      const ox = rect.left + (rect.width - box.w) / 2;
      const oy = rect.top + (rect.height - box.h) / 2;
      return {
        x: clamp(((clientX - ox) / box.w) * width, 0, width),
        y: clamp(((clientY - oy) / box.h) * height, 0, height),
      };
    },
    [box.h, box.w, height, width]
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

  const begin = (index: number | "move") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { index, start: toImage(e.clientX, e.clientY), origin: corners };
    if (navigator.vibrate) navigator.vibrate(8);
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    e.preventDefault();
    const p = toImage(e.clientX, e.clientY);

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

    schedule(clampCorner(d.origin, d.index, p, width, height));
  };

  const end = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    pending.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  /* --------------------------------------------------------------- render */
  const px = (v: number, total: number) => `${(v / total) * 100}%`;
  const centre = centroid(corners);

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
            className="pointer-events-none absolute inset-0 h-full w-full object-fill"
            draggable={false}
          />
        </div>

        {/* Dim everything outside the selection. */}
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
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
          className="pointer-events-none absolute inset-0 h-full w-full opacity-40"
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
            style={{ left: px(c.x, width), top: px(c.y, height) }}
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
          style={{ left: px(centre.x, width), top: px(centre.y, height) }}
          title="Drag to move the whole crop"
        >
          <Move size={18} />
        </div>

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
