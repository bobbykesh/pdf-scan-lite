"use client";

import { useEffect, useRef } from "react";

/**
 * The magnifier that follows your finger while cropping.
 *
 * It is a thin ring rather than a filled bubble: no backdrop, no tint, no
 * shadow. You look *through* it, so it can sit over the photo without hiding
 * the thing you are trying to line up.
 *
 * What it shows is the point under your finger at a fixed magnification, drawn
 * from the full-resolution capture — a loupe fed from the 1100px on-screen
 * preview would be showing you JPEG mush, and you would end up aligning the
 * crop to compression artefacts instead of to the page edge.
 */

export interface LoupeState {
  /** finger position, in CSS px relative to the crop frame */
  x: number;
  y: number;
  /** where the ring should be drawn, same coordinate space */
  cx: number;
  cy: number;
  /** 0..1, for the fade in/out */
  opacity: number;
}

/** Diameter of the ring, in CSS px (matches the reference: small, unobtrusive). */
export const LOUPE_SIZE = 88;
/** How much the loupe magnifies. */
const LOUPE_ZOOM = 3.5;

export default function CropLoupe({
  state,
  source,
  /** offset of the photo inside the crop frame, in css px */
  origin,
  /** how many css px the whole capture spans on screen */
  frameWidth,
  /** width of the capture in the units the crop quad is expressed in */
  captureWidth,
  /** source px per capture px (the working copy is a scaled capture) */
  sourceScale,
}: {
  state: LoupeState;
  source: HTMLCanvasElement | null;
  origin: { x: number; y: number };
  frameWidth: number;
  captureWidth: number;
  sourceScale: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source || state.opacity <= 0) return;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const size = LOUPE_SIZE;
    const r = size / 2;
    const zoom = LOUPE_ZOOM;

    /*
     * What the loupe shows: the source pixels under the finger.
     *
     * `displayScale` converts displayed px → source px. The loupe is zoomed in
     * on top of that, so one CSS px of the loupe covers 1/(displayScale*zoom)
     * source px.
     */
    /*
     * One coordinate story, no preview in it.
     *
     * The quad and the capture width are the same units, so work there:
     *   frame css → capture px  (× captureWidth / frameWidth)
     *   capture px → source px  (× sourceScale)
     * Earlier versions mixed the css-per-preview-px scale with a working copy
     * of a different size, which pointed the loupe at the wrong part of the
     * image — often past its edge, hence the black circle.
     */
    const cssPerCapture = Math.max(1e-6, frameWidth) / Math.max(1, captureWidth);
    const capturePerLoupe = 1 / (cssPerCapture * zoom); // capture px per loupe px
    const side = size * capturePerLoupe * sourceScale; // source px shown

    const capX = (state.x - origin.x) / cssPerCapture;
    const capY = (state.y - origin.y) / cssPerCapture;

    /*
     * Keep the finger point dead centre — do NOT clamp the window to the image.
     *
     * Clamping pinned the window inside the photo, which shifted the sampled
     * area away from the point under the finger exactly when it mattered (at a
     * page corner, where you are placing the crop). And any part of the window
     * outside the photo was left transparent, so the ring went black and looked
     * broken.
     *
     * Instead the window is allowed to overhang, and the overhang is filled
     * with a neutral paper tone: you still see the page edge crossing the ring,
     * which is the whole point of the loupe.
     */
    const sx = capX * sourceScale - side / 2;
    const sy = capY * sourceScale - side / 2;

    ctx.save();
    ctx.clearRect(0, 0, size, size);

    // Circular clip, so the magnified photo fills the ring exactly.
    ctx.beginPath();
    ctx.arc(r, r, r - 1, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = "#d8d8d8"; // neutral: reads as "outside the photo", never black
    ctx.fillRect(0, 0, size, size);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, sx, sy, side, side, 0, 0, size, size);

    ctx.restore();
  }, [state.x, state.y, state.opacity, source, frameWidth, captureWidth, sourceScale, origin.x, origin.y]);

  return (
    <div
      className="pointer-events-none absolute z-40"
      style={{
        left: state.cx - LOUPE_SIZE / 2,
        top: state.cy - LOUPE_SIZE / 2,
        width: LOUPE_SIZE,
        height: LOUPE_SIZE,
        opacity: state.opacity,
        transition: "opacity 120ms ease-out",
      }}
      aria-hidden
    >
      {/*
       * The ring: one hairline, nothing else. The reference has a 1–2px white
       * stroke and no fill, which is what keeps it out of the way.
       */}
      <canvas
        ref={canvasRef}
        width={LOUPE_SIZE}
        height={LOUPE_SIZE}
        className="absolute inset-0 rounded-full"
      />
      {/*
       * The ring itself: a hairline circle drawn on top rather than a CSS
       * shadow, so it stays crisp on white paper (a blurred shadow disappears
       * against the page). Dark outer edge keeps it visible over white, the
       * white inner edge keeps it visible over dark backgrounds.
       */}
      <svg
        className="absolute inset-0"
        width={LOUPE_SIZE}
        height={LOUPE_SIZE}
        viewBox={`0 0 ${LOUPE_SIZE} ${LOUPE_SIZE}`}
        aria-hidden
      >
        <circle
          cx={LOUPE_SIZE / 2}
          cy={LOUPE_SIZE / 2}
          r={LOUPE_SIZE / 2 - 1}
          fill="none"
          stroke="rgba(0,0,0,0.45)"
          strokeWidth={3}
        />
        <circle
          cx={LOUPE_SIZE / 2}
          cy={LOUPE_SIZE / 2}
          r={LOUPE_SIZE / 2 - 2.5}
          fill="none"
          stroke="#ffffff"
          strokeWidth={2}
        />
      </svg>
      {/* crosshair marking the exact point under the finger */}
      <div className="absolute left-1/2 top-1/2 h-[9px] w-px -translate-x-1/2 -translate-y-1/2 bg-white/70" />
      <div className="absolute left-1/2 top-1/2 h-px w-[9px] -translate-x-1/2 -translate-y-1/2 bg-white/70" />
    </div>
  );
}
