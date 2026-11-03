"use client";

import { useEffect, useRef } from "react";
import type { Point } from "@/types";
import { warpPerspective } from "@/lib/imaging";

/**
 * A live preview of the straightened page while cropping.
 *
 * Runs the *same* warp the final crop uses, just at a deliberately tiny size,
 * so it cannot disagree with the result. Full-resolution warping on every
 * pointer move would stall a phone, so the source is a downscaled copy and the
 * output is a thumbnail: this is for judging geometry, not sharpness.
 */

/** Long edge of the working copy the preview warps from. */
const WORK_SIDE = 340;
/** Long edge of the thumbnail. */
const THUMB_SIDE = 150;

/** Keep in sync with CARD_W in CropStage.tsx. */
const CARD_W = 122;

export default function CropThumb({
  quad,
  source,
  visible,
  /** where to park the card, in crop-frame coordinates */
  side,
}: {
  quad: [Point, Point, Point, Point];
  source: HTMLCanvasElement | null;
  visible: boolean;
  side: { left: number | string; top: number | string };
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const work = useRef<{ canvas: HTMLCanvasElement; w: number; h: number } | null>(null);
  /** working-copy px per capture px */
  const workScale = useRef(1);
  const frame = useRef(0);
  const lastKey = useRef("");

  // Build the small working copy once per source.
  useEffect(() => {
    if (!source) return;
    const scale = Math.min(1, WORK_SIDE / Math.max(source.width, source.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(source.width * scale));
    c.height = Math.max(1, Math.round(source.height * scale));
    const ctx = c.getContext("2d", { alpha: false })!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, c.width, c.height);
    work.current = { canvas: c, w: source.width, h: source.height };
    workScale.current = c.width / Math.max(1, source.width);
    lastKey.current = ""; // force a redraw for the new source
  }, [source]);

  useEffect(() => {
    if (!visible) return;
    const canvas = ref.current;
    const w = work.current;
    if (!canvas || !w) return;

    // Skip work when the quad has not actually moved.
    const key = quad.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join("|");
    if (key === lastKey.current) return;
    lastKey.current = key;

    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      /*
       * The quad is expressed in capture pixels, so the working copy has to be
       * mapped from the capture's size — not from its own. Using the working
       * canvas's own width here was fine only while the two happened to be the
       * same size; on a filtered or differently-sized copy it warps the wrong
       * region and the card shows a cropped corner of the page.
       */
      void w;
      const k = workScale.current;
      const small = quad.map((p) => ({ x: p.x * k, y: p.y * k })) as [
        Point,
        Point,
        Point,
        Point,
      ];
      try {
        const { canvas: out } = warpPerspective(w.canvas, small, THUMB_SIDE);
        canvas.width = out.width;
        canvas.height = out.height;
        const ctx = canvas.getContext("2d", { alpha: false })!;
        ctx.drawImage(out, 0, 0);
      } catch {
        /* a degenerate quad mid-drag — leave the last good frame */
      }
    });

    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [quad, visible]);

  return (
    <div
      className="pointer-events-none absolute z-40 rounded-lg border border-white/25 bg-black/70 p-1 shadow-[0_6px_24px_rgba(0,0,0,0.5)] backdrop-blur-sm"
      style={{
        left: side.left,
        top: side.top,
        // Fixed footprint: CropStage scores candidate slots against exactly
        // this box, so the card and the placement maths cannot drift apart.
        width: CARD_W,
        opacity: visible ? 1 : 0,
        transition: "opacity 140ms ease-out",
      }}
      aria-hidden
    >
      <canvas ref={ref} className="block max-h-[84px] w-full rounded" />
      <p className="pt-0.5 text-center text-[8px] uppercase tracking-wider text-white/55">result</p>
    </div>
  );
}
