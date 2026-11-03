"use client";

/**
 * Image pipeline for the HD scanner:
 *  - camera stream helpers (rear camera, max resolution stills)
 *  - document corner detection (auto-crop)
 *  - perspective (homography) correction
 *  - scan filters: vivid colour, grayscale, high-contrast B&W (Otsu)
 *  - background colour sampling for "smart erase"
 * Everything runs on <canvas>, no network, no native deps.
 */
import type { Point } from "@/types";

export type ScanFilter = "original" | "vivid" | "gray" | "bw";

export function canvasFromImage(img: HTMLImageElement | ImageBitmap, maxSide = 2600): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const ctx = c.getContext("2d", { alpha: false })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/* ------------------------------------------------------------------ camera */

export interface CameraHandle {
  stream: MediaStream;
  video: HTMLVideoElement;
  track: MediaStreamTrack;
  stop: () => void;
}

export async function startCamera(opts: { facingMode?: "environment" | "user"; deviceId?: string } = {}): Promise<CameraHandle> {
  const constraints: MediaStreamConstraints = {
    audio: false,
    video: opts.deviceId
      ? { deviceId: { exact: opts.deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 } }
      : {
          facingMode: { ideal: opts.facingMode ?? "environment" },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  await video.play().catch(() => {});
  const track = stream.getVideoTracks()[0];
  // ask for the biggest still the sensor can give us
  try {
    const caps = track.getCapabilities?.() as MediaTrackCapabilities & { width?: { max?: number }; height?: { max?: number } };
    if (caps?.width?.max && caps?.height?.max) {
      await track.applyConstraints({ width: { ideal: caps.width.max }, height: { ideal: caps.height.max } } as MediaTrackConstraints);
    }
  } catch {
    /* not supported on this browser */
  }
  return { stream, video, track, stop: () => stream.getTracks().forEach((t) => t.stop()) };
}

/** Grab the sharpest available frame: ImageCapture still if possible, else the video frame. */
/** True when a canvas is essentially a single flat colour (a failed grab). */
export function frameHasContent(canvas: HTMLCanvasElement): boolean {
  return !isFlat(canvas);
}

function isFlat(canvas: HTMLCanvasElement): boolean {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext("2d", { alpha: false })!;
  ctx.drawImage(canvas, 0, 0, 32, 32);
  const d = ctx.getImageData(0, 0, 32, 32).data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
    if (l < min) min = l;
    if (l > max) max = l;
  }
  return max - min < 3;
}

/**
 * Grab the current camera frame.
 *
 * Order of preference:
 *  1. `ImageCapture.takePhoto()` — full sensor resolution, sharpest text.
 *  2. The `<video>` element — always works, but capped to the preview resolution.
 *
 * Both results are validated: a flat/black result means the grab failed, so we
 * fall back instead of silently handing the user a black page.
 */
export async function captureFrame(
  video: HTMLVideoElement,
  track?: MediaStreamTrack,
  maxSide = 2600
): Promise<HTMLCanvasElement> {
  type ImageCaptureCtor = new (t: MediaStreamTrack) => { takePhoto: () => Promise<Blob> };
  const IC = (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
  if (IC && track && track.readyState === "live") {
    try {
      const blob = await new IC(track).takePhoto();
      if (blob && blob.size > 0) {
        const bmp = await createImageBitmap(blob);
        const canvas = canvasFromImage(bmp, maxSide);
        bmp.close?.();
        if (!isFlat(canvas)) return canvas;
      }
    } catch {
      /* fall through to the video frame */
    }
  }
  return videoFrameCanvas(video, maxSide);
}

export function videoFrameCanvas(video: HTMLVideoElement, maxSide = 2600): HTMLCanvasElement {
  const vw = video.videoWidth || 1920;
  const vh = video.videoHeight || 1080;
  const scale = Math.min(1, maxSide / Math.max(vw, vh));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(vw * scale));
  c.height = Math.max(1, Math.round(vh * scale));
  const ctx = c.getContext("2d", { alpha: false })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(video, 0, 0, c.width, c.height);
  return c;
}

/* ------------------------------------------------------- corner detection */

/**
 * Auto-crop.
 *
 * 1. downsample, convert to luminance
 * 2. Otsu threshold → bright/dark mask (polarity detected from the border ring,
 *    so a dark page on a light table works too)
 * 3. keep the largest connected component = the sheet
 * 4. refine each side by searching for the strongest gradient near the mask
 *    bounding box, which recovers pages that touch the frame edge
 *
 * The result is an axis-aligned quad the user can drag for perspective.
 */
export interface QuadDetection {
  /** TL, TR, BR, BL in source pixels */
  corners: [Point, Point, Point, Point];
  /** 0..1 — how page-like the result is */
  confidence: number;
  /** false when we fell back to the full frame */
  found: boolean;
}

const FULL_FRAME = (w: number, h: number): [Point, Point, Point, Point] => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];

function quadArea(q: [Point, Point, Point, Point]): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** All cross products share a sign → the quad is convex and not self-crossing. */
function isConvex(q: [Point, Point, Point, Point]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function sideLengths(q: [Point, Point, Point, Point]): number[] {
  return q.map((a, i) => {
    const b = q[(i + 1) % 4];
    return Math.hypot(b.x - a.x, b.y - a.y);
  });
}

/**
 * Find the page as a true four-point quad.
 *
 * The previous implementation returned an axis-aligned bounding box, so any
 * photo taken at an angle was "cropped" to a rectangle that included the desk.
 * This version segments the brightest large region, then derives perspective
 * corners from the extreme points of that region (min/max of x+y and x−y),
 * which recovers rotation and keystone distortion instead of boxing it.
 */
/**
 * Find the page as a true four-point quad.
 *
 * Why this is not a simple threshold any more
 * ------------------------------------------
 * The old version thresholded the whole frame with Otsu and took the extreme
 * points of the largest connected blob. On a real photo that fails badly:
 *
 *   • a bright floor / wall / specular highlight joins the paper into one blob,
 *     so the "page" was reported as a quad covering half the floor;
 *   • a dark or glossy card (an ID, a laminated sheet) is *darker* than the
 *     floor, so the bright-document assumption is inverted;
 *   • Otsu computed from the full histogram is skewed by the background.
 *
 * The replacement works the way phone scanner apps do:
 *
 *   1. work on a small greyscale copy (320px wide) for speed;
 *   2. threshold *locally* (generous Otsu) and then knock out anything touching
 *      the frame border — the document is the big object in the middle, not
 *      the desk/carpet that runs off every edge;
 *   3. score every remaining component by how paper-like it is (area,
 *      rectangularity, aspect ratio) and keep the best;
 *   4. take the convex hull, simplify it to four points with Douglas–Peucker,
 *      and fit minimum-area rectangle corners to that hull so the quad follows
 *      the sheet's real edges instead of a few noisy extreme pixels;
 *   5. refine each corner against the image gradient, which snaps the handles
 *      onto the printed border.
 */
export function detectDocumentCornersDetailed(source: HTMLCanvasElement): QuadDetection {
  const W = 320;
  const H = Math.max(1, Math.round((source.height / source.width) * W));
  const small = document.createElement("canvas");
  small.width = W;
  small.height = H;
  const sctx = small.getContext("2d", { alpha: false })!;
  sctx.drawImage(source, 0, 0, W, H);
  const { data } = sctx.getImageData(0, 0, W, H);

  const lum = new Float32Array(W * H);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    lum[p] = l;
    hist[l | 0]++;
  }

  const toSource = (x: number, y: number): Point => ({
    x: Math.min(source.width, Math.max(0, (x / W) * source.width)),
    y: Math.min(source.height, Math.max(0, (y / H) * source.height)),
  });

  const frameArea = source.width * source.height;
  const fallback: QuadDetection = {
    corners: FULL_FRAME(source.width, source.height),
    confidence: 0,
    found: false,
  };

  /* ---------------------------------------------------------- candidates */

  /**
   * Build a mask of "document-ish" pixels at an absolute luminance threshold.
   * `brightDoc` picks the polarity: paper brighter than its surroundings, or
   * darker (a dark card, a laminated ID, a phone screen).
   */
  const buildMask = (brightDoc: boolean, t: number): Uint8Array => {
    const m = new Uint8Array(W * H);
    for (let p = 0; p < m.length; p++) {
      m[p] = (brightDoc ? lum[p] > t : lum[p] < t) ? 1 : 0;
    }
    return m;
  };

  /**
   * Remove large components that touch the border of the frame.
   *
   * A sheet lying in the middle of a photo never reaches the edge; floors,
   * walls, tabletops and shadows almost always do. This is the single most
   * effective guard against "the crop took half the room".
   */
  const dropBorderComponents = (mask: Uint8Array): Uint8Array => {
    const seen = new Uint8Array(W * H);
    const stack: number[] = [];
    const out = mask.slice();
    for (let p0 = 0; p0 < mask.length; p0++) {
      if (!mask[p0] || seen[p0]) continue;
      const pixels: number[] = [];
      let touches = false;
      stack.length = 0;
      stack.push(p0);
      seen[p0] = 1;
      while (stack.length) {
        const p = stack.pop()!;
        pixels.push(p);
        const x = p % W;
        const y = (p - x) / W;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touches = true;
        if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
        if (x < W - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
        if (y > 0 && mask[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
        if (y < H - 1 && mask[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
      }
      if (touches) {
        for (const p of pixels) out[p] = 0;
      }
    }
    return out;
  };

  /** Connected components of a mask, largest first. */
  const components = (mask: Uint8Array): number[][] => {
    const seen = new Uint8Array(W * H);
    const stack: number[] = [];
    const list: number[][] = [];
    for (let p0 = 0; p0 < mask.length; p0++) {
      if (!mask[p0] || seen[p0]) continue;
      const pixels: number[] = [];
      stack.length = 0;
      stack.push(p0);
      seen[p0] = 1;
      while (stack.length) {
        const p = stack.pop()!;
        pixels.push(p);
        const x = p % W;
        const y = (p - x) / W;
        if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
        if (x < W - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
        if (y > 0 && mask[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
        if (y < H - 1 && mask[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
      }
      if (pixels.length >= W * H * 0.02) list.push(pixels);
    }
    list.sort((a, b) => b.length - a.length);
    return list.slice(0, 4);
  };

  /**
   * Score a candidate quad. This is the heart of the new detector: a crop is
   * only accepted when it *looks like a sheet* — rectangular, with a strong
   * luminance step along all four edges, and a sane aspect ratio. Area alone is
   * not evidence (the old code treated "big bright blob" as "the document",
   * which is exactly how half a tiled floor became the page).
   */
  const scoreQuad = (quad: [Point, Point, Point, Point]): number => {
    if (!isConvex(quad)) return -1;
    const area = quadArea(quad);
    const frac = area / frameArea;
    if (frac < 0.03 || frac > 0.92) return -1;
    const sides = sideLengths(quad);
    const longest = Math.max(...sides);
    const shortest = Math.min(...sides);
    if (shortest < Math.min(source.width, source.height) * 0.05) return -1;
    const rectFill = area / (longest * shortest); // 1 = perfect rectangle
    const aspect = longest / Math.max(1, shortest);
    const { mean: edge, consistency } = edgeContrast(quad, lum, W, H, source.width, source.height);
    const areaScore = frac < 0.06 ? 0.3 : 1;
    return (
      rectFill * 0.26 +
      Math.min(1, edge / 30) * 0.32 +
      consistency * 0.22 +
      aspectPrior(aspect) * 0.14 +
      areaScore * 0.06
    );
  };

  /**
   * Adaptive (local-mean) masks.
   *
   * A cream card on a cream tiled floor, or a white page lit unevenly, are
   * exactly the cases a global threshold cannot separate: paper and background
   * land in the same histogram bucket. Comparing each pixel with the mean of
   * its neighbourhood (via a summed-area table, so this stays O(n)) isolates a
   * locally-brighter or locally-darker region regardless of the global level.
   */
  const integral = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      rowSum += lum[y * W + x];
      integral[(y + 1) * (W + 1) + (x + 1)] = integral[y * (W + 1) + (x + 1)] + rowSum;
    }
  }
  const localMean = (x: number, y: number, r: number): number => {
    const x0 = Math.max(0, x - r);
    const y0 = Math.max(0, y - r);
    const x1 = Math.min(W - 1, x + r);
    const y1 = Math.min(H - 1, y + r);
    const a = integral[y0 * (W + 1) + x0];
    const b = integral[y0 * (W + 1) + (x1 + 1)];
    const c = integral[(y1 + 1) * (W + 1) + x0];
    const d = integral[(y1 + 1) * (W + 1) + (x1 + 1)];
    return (d - b - c + a) / ((x1 - x0 + 1) * (y1 - y0 + 1));
  };
  const buildAdaptiveMask = (brightDoc: boolean, k: number, radius: number): Uint8Array => {
    const m = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        const mean = localMean(x, y, radius);
        const diff = lum[p] - mean;
        const on = brightDoc ? diff > k : diff < -k;
        m[p] = on ? 1 : 0;
      }
    }
    return m;
  };

  const luminanceLevels: number[] = [];
  {
    // Sweep thresholds across the tonal range instead of trusting one Otsu cut.
    // On a cream card lying on a cream floor the histogram is unimodal, so any
    // single global threshold merges paper and floor into one blob; sweeping
    // finds the cut that isolates the card.
    let acc = 0;
    const total = W * H;
    for (let level = 0; level < 256 && luminanceLevels.length < 12; level++) {
      acc += hist[level];
      if (acc / total >= (luminanceLevels.length + 1) / 13) luminanceLevels.push(level);
    }
    // plus a few absolute levels, which catch low-contrast cards
    for (const t of [70, 130, 190, 225, 240]) luminanceLevels.push(t);
  }

  type Cand = { quad: [Point, Point, Point, Point]; score: number; area: number; covered: number };
  const all: Cand[] = [];

  const masks: { mask: Uint8Array; tag: string }[] = [];
  for (const t of luminanceLevels) {
    masks.push({ mask: buildMask(true, t), tag: `g+${t}` });
    masks.push({ mask: buildMask(false, t), tag: `g-${t}` });
  }
  for (const radius of [12, 26]) {
    for (const k of [6, 13]) {
      masks.push({ mask: buildAdaptiveMask(true, k, radius), tag: `a+${k}/${radius}` });
      masks.push({ mask: buildAdaptiveMask(false, k, radius), tag: `a-${k}/${radius}` });
    }
  }

  for (const { mask } of masks) {
    {
      const inner = dropBorderComponents(mask);
      for (const pixels of components(inner)) {
        const quad = quadFromComponent(pixels, W, H, source);
        if (!quad) continue;
        const score = scoreQuad(quad);
        if (score <= 0) continue;
        all.push({ quad, score, area: quadArea(quad), covered: pixels.length / (W * H) });
      }
    }
  }

  /**
   * Pick the winner among the good candidates.
   *
   * A glossy card splits into two blobs (the glare and the rest), and the glare
   * blob can score slightly higher because its boundary is a sharper gradient.
   * Cropping to the glare is exactly the "messy scan" the user reported, so
   * when a candidate is nearly as good as the best but much larger, take the
   * larger one — a scanner should capture the whole sheet, not its highlight.
   */
  all.sort((a, b) => b.score - a.score);
  let best: Cand | null = null;
  if (all.length) {
    const top = all[0];
    best = top;
    for (const c of all) {
      if (c.score < top.score * 0.8) break;
      if (c.area > best.area * 1.15) best = c;
    }
  }

  if (!best) return fallback;

  /**
   * Snap each corner onto the real paper edge.
   *
   * The quad comes from a 320px-wide mask, so it is only accurate to ~4 source
   * pixels and tends to sit a pixel or two outside the sheet, which shows up as
   * a thin strip of floor/desk down the edges of the scan. This walks each
   * corner along the two edges that meet there and maximises |gradient| across
   * the edge, which lands it on the printed border.
   */
  const refined = refineQuadToEdges(best.quad, lum, W, H, source);
  const rawScore2 = scoreQuad(best.quad);
  const refScore2 = scoreQuad(refined);
  // only take the refined corners when they are a clear improvement
  const quad = refScore2 > rawScore2 + 0.01 ? refined : best.quad;
  const area = quadArea(quad);
  const sides = sideLengths(quad);
  const longest = Math.max(...sides);
  const shortest = Math.min(...sides);
  const rectFill = area / (longest * shortest);
  const aspect = longest / Math.max(1, shortest);
  const { mean: edge, consistency } = edgeContrast(quad, lum, W, H, source.width, source.height);

  /**
   * Confidence answers one question: "is this a rectangular sheet with a real
   * boundary?" It gates whether auto-crop is trusted at all, so a quad that
   * swallowed the floor scores low and the caller falls back to the full frame.
   */
  /*
   * Pull the quad in by a hair.
   *
   * The mask boundary sits a pixel or two outside the printed edge (and the
   * mask is computed at 320 px, so a source pixel is worth three), which shows
   * up as a thin ribbon of desk along the scan. A ~0.6% inset is invisible on
   * the page but reliably swallows that ribbon; it stays inside the coordinate
   * space, so the corner handles keep their meaning.
   */
  const insetQuad = (q: [Point, Point, Point, Point], f: number): [Point, Point, Point, Point] => {
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
    const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    return q.map((p) => ({ x: p.x + (cx - p.x) * f, y: p.y + (cy - p.y) * f })) as [Point, Point, Point, Point];
  };
  const finalQuad = insetQuad(quad, 0.006);

  const confidence = Math.max(
    0,
    Math.min(
      1,
      rectFill * 0.26 +
        Math.min(1, edge / 30) * 0.32 +
        consistency * 0.22 +
        aspectPrior(aspect) * 0.14 +
        0.06
    )
  );

  const plausible = confidence >= 0.5;
  return {
    corners: plausible ? finalQuad : FULL_FRAME(source.width, source.height),
    confidence: plausible ? confidence : Math.min(confidence, 0.49),
    found: plausible,
  };
}

/**
 * Move each corner of a quad onto the strongest nearby edge.
 *
 * For a corner, the two edges that meet there are known, so the search is 2D:
 * a corner is tried at (du along edge A, dv along edge B) and scored by the
 * summed absolute gradient across both edges at that point. A small search
 * window keeps it from jumping to a different feature.
 */
function refineQuadToEdges(
  quad: [Point, Point, Point, Point],
  lum: Float32Array,
  W: number,
  H: number,
  source: HTMLCanvasElement
): [Point, Point, Point, Point] {
  const at = (x: number, y: number): number => {
    const xi = Math.min(W - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(H - 1, Math.max(0, Math.round(y)));
    return lum[yi * W + xi];
  };
  /** gradient across the line through p1→p2, sampled at t */
  const edgeScore = (p1: { x: number; y: number }, p2: { x: number; y: number }): number => {
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const nx = -(p2.y - p1.y) / len;
    const ny = (p2.x - p1.x) / len;
    let total = 0;
    const steps = 20;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = p1.x + (p2.x - p1.x) * t;
      const y = p1.y + (p2.y - p1.y) * t;
      total += Math.abs(at(x + nx * 1.6, y + ny * 1.6) - at(x - nx * 1.6, y - ny * 1.6));
    }
    return total / (steps - 1);
  };

  const q = quad.map((p) => ({ x: (p.x / Math.max(1, source.width)) * W, y: (p.y / Math.max(1, source.height)) * H }));
  const out = q.map((p) => ({ ...p }));
  /*
   * Keep the search tiny. A wide window lets a corner jump onto any other
   * strong line nearby — grout between tiles, the edge of a desk, a shadow —
   * which silently replaced a correct page quad with the wrong rectangle
   * during testing. 1.5 small-grid px is ~6 source px, enough to pull a corner
   * off the mask boundary and onto the printed edge, but not enough to reach a
   * different feature.
   */
  const R = 1.5; // small-grid pixels
  const STEP = 0.5;

  for (let i = 0; i < 4; i++) {
    const prev = q[(i + 3) % 4];
    const cur = q[i];
    const next = q[(i + 1) % 4];
    let bestScore = -1;
    let bx = cur.x;
    let by = cur.y;
    for (let dy = -R; dy <= R; dy += STEP) {
      for (let dx = -R; dx <= R; dx += STEP) {
        const cand = { x: cur.x + dx, y: cur.y + dy };
        /*
         * The movement penalty matters more than it looks. Without it a corner
         * happily slid ~18 px *along* an edge — the gradient it found there was
         * just as strong (a shadow line running parallel to the page) — which
         * pushed that corner out over the background. The mask rectangle is
         * already within a few pixels, so only accept a move that clearly
         * improves the edge.
         */
        const moved = Math.hypot(dx, dy);
        const sc = edgeScore(prev, cand) + edgeScore(cand, next) - moved * 1.8;
        if (sc > bestScore) {
          bestScore = sc;
          bx = cand.x;
          by = cand.y;
        }
      }
    }
    out[i] = { x: bx, y: by };
  }

  return out.map((p) => ({
    x: Math.min(source.width, Math.max(0, (p.x / W) * source.width)),
    y: Math.min(source.height, Math.max(0, (p.y / H) * source.height)),
  })) as [Point, Point, Point, Point];
}

/**
 * Corners of the minimum-area rectangle around a pixel blob, mapped to source
 * pixels. Deriving the quad from a fitted rectangle (instead of from four
 * extreme pixels) is what stops single noisy specks from dragging a corner out
 * into the middle of the floor.
 */
function quadFromComponent(
  pixels: number[],
  W: number,
  H: number,
  source: HTMLCanvasElement
): [Point, Point, Point, Point] | null {
  if (pixels.length < 12) return null;

  // convex hull (monotone chain) of the blob
  const pts: { x: number; y: number }[] = [];
  const stride = Math.max(1, Math.floor(pixels.length / 4000));
  for (let i = 0; i < pixels.length; i += stride) {
    const p = pixels[i];
    const x = p % W;
    pts.push({ x, y: (p - x) / W });
  }
  if (pts.length < 4) return null;
  pts.sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: { x: number; y: number }[] = [];
  for (const pt of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: { x: number; y: number }[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const pt = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (hull.length < 3) return null;

  // minimum-area rotated rectangle over the hull (rotating calipers, O(n·hull))
  let bestArea = Infinity;
  let bestAngle = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const cos = Math.cos(-ang);
    const sin = Math.sin(-ang);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * cos - p.y * sin;
      const v = p.x * sin + p.y * cos;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      bestAngle = ang;
    }
  }

  const cos = Math.cos(-bestAngle);
  const sin = Math.sin(-bestAngle);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of hull) {
    const u = p.x * cos - p.y * sin;
    const v = p.x * sin + p.y * cos;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const unrotate = (u: number, v: number) => {
    const a = Math.cos(bestAngle);
    const b = Math.sin(bestAngle);
    return { x: u * a - v * b, y: u * b + v * a };
  };
  const c = [
    unrotate(minU, minV),
    unrotate(maxU, minV),
    unrotate(maxU, maxV),
    unrotate(minU, maxV),
  ];

  // order as TL, TR, BR, BL so the rest of the pipeline (and the handles) agree
  const cx = c.reduce((s, p) => s + p.x, 0) / 4;
  const cy = c.reduce((s, p) => s + p.y, 0) / 4;
  const ordered = c
    .map((p) => ({ ...p, a: Math.atan2(p.y - cy, p.x - cx) }))
    .sort((p, q) => p.a - q.a)
    .map(({ x, y }) => ({ x, y }));
  // atan2 order starting from -135° gives TL, TR, BR, BL
  const start = ordered.reduce((bi, p, i, arr) => (p.x + p.y < arr[bi].x + arr[bi].y ? i : bi), 0);
  const rot = [...ordered.slice(start), ...ordered.slice(0, start)];
  const mapped: [Point, Point, Point, Point] = [
    mapSmall(rot[0], W, H, source),
    mapSmall(rot[1], W, H, source),
    mapSmall(rot[2], W, H, source),
    mapSmall(rot[3], W, H, source),
  ];
  // make sure the first point really is the top-left
  if (mapped[0].x + mapped[0].y > mapped[2].x + mapped[2].y) {
    mapped.reverse();
  }
  return mapped;
}

function mapSmall(p: { x: number; y: number }, W: number, H: number, source: HTMLCanvasElement): Point {
  return {
    x: Math.min(source.width, Math.max(0, (p.x / W) * source.width)),
    y: Math.min(source.height, Math.max(0, (p.y / H) * source.height)),
  };
}

/**
 * Mean gradient magnitude sampled along the four edges of a quad.
 *
 * A genuine sheet edge crosses paper→background, so the gradient is strong and
 * consistent. A quad that wanders through a carpet texture or across a wall
 * has weak, patchy edges. This is the signal that lets the caller decide
 * whether auto-crop should be trusted.
 *
 * `lum` is the small greyscale image (W×H); the quad is in source pixels, so
 * each sample is scaled into that grid.
 */
function edgeContrast(
  q: [Point, Point, Point, Point],
  lum: Float32Array,
  W: number,
  H: number,
  sourceW: number,
  sourceH: number
): { mean: number; consistency: number } {
  const at = (x: number, y: number): number => {
    const xi = Math.min(W - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(H - 1, Math.max(0, Math.round(y)));
    return lum[yi * W + xi];
  };
  let total = 0;
  let strong = 0;
  let n = 0;
  const steps = 28;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    // outward normal of this edge (in small-grid units)
    const ax = (a.x / Math.max(1, sourceW)) * W;
    const ay = (a.y / Math.max(1, sourceH)) * H;
    const bx = (b.x / Math.max(1, sourceW)) * W;
    const by = (b.y / Math.max(1, sourceH)) * H;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let nx = -(by - ay) / len;
    let ny = (bx - ax) / len;
    const mid = { x: (ax + bx) / 2, y: (ay + by) / 2 };
    // point the normal away from the quad's centre
    const cx = q.reduce((s, p) => s + (p.x / Math.max(1, sourceW)) * W, 0) / 4;
    const cy = q.reduce((s, p) => s + (p.y / Math.max(1, sourceH)) * H, 0) / 4;
    if (nx * (mid.x - cx) + ny * (mid.y - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    for (let s2 = 1; s2 < steps; s2++) {
      const t = s2 / steps;
      const px = ax + (bx - ax) * t;
      const py = ay + (by - ay) * t;
      const inside = at(px - nx * 2, py - ny * 2);
      const outside = at(px + nx * 2, py + ny * 2);
      const step = Math.abs(outside - inside);
      total += step;
      if (step > 12) strong++;
      n++;
    }
  }
  return { mean: n ? total / n : 0, consistency: n ? strong / n : 0 };
}


export function detectDocumentCorners(source: HTMLCanvasElement): [Point, Point, Point, Point] {
  return detectDocumentCornersDetailed(source).corners;
}

function otsu(hist: Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = i;
    }
  }
  return best;
}

/* --------------------------------------------------- perspective transform */

/** Solve an 8×8 linear system (Gaussian elimination) for the homography. */
function solve8(A: number[][], b: number[]): number[] {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) throw new Error("degenerate quad");
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (!f) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

export interface WarpResult {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/** Destination size for a quad: long edge capped, never upscaled past source. */
/**
 * How plausible a long/short side ratio is for a scanned sheet.
 *
 * A Gaussian in log space centred on the most common shapes (a 4x3 photo of a
 * page and an A4 sheet both land near 1.3-1.4, an ID card near 1.6, a receipt
 * further out). A hard window with a cliff edge — the previous approach — was
 * actively harmful: it scored a 4:1 band of floor *higher* than the 2.6:1
 * boundary of the card that was actually in the photo.
 */
function aspectPrior(aspect: number): number {
  const target = aspect < 1 ? 1 / Math.max(0.2, aspect) : aspect;
  const l = Math.log(Math.max(1, target) / 1.38);
  return Math.exp(-(l * l) / (2 * 0.34 * 0.34));
}

/** Aspect ratios a scanned sheet is allowed to snap to. */
const SHEET_ASPECTS = [
  1 / 1.414, // A4 portrait
  1 / 1.294, // US Letter portrait
  1 / 1.333, // 4x3 card / photo
  1 / 1.6, // ID-1 (credit card, driver's licence, national ID)
  1 / 1.5, // 3x2 photo
  1 / 2.0, // long receipt
];

/**
 * Output size for a warp.
 *
 * A quad in a photo is a *perspective* view of a rectangle, so its top edge is
 * shorter in pixels than the real page whenever the top of the sheet is
 * further away. Sizing the output by those raw pixel lengths (what this used to
 * do) squashed the page unevenly, which is what made scans look distorted on
 * one axis and "messy".
 *
 * The width is taken from the widest edge (least foreshortened) and the height
 * is then derived from a plausible sheet aspect ratio rather than from the
 * measured height, so the warped page has the shape of real paper instead of
 * whatever the perspective happened to produce.
 */
export function warpSize(
  quad: [Point, Point, Point, Point],
  maxSide = 2400
): { width: number; height: number } {
  const [tl, tr, br, bl] = quad;
  const wTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const wBottom = Math.hypot(br.x - bl.x, br.y - bl.y);
  const hLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const hRight = Math.hypot(br.x - tr.x, br.y - tr.y);

  const widthPx = Math.max(wTop, wBottom);
  const heightPx = Math.max(hLeft, hRight);

  // measured shape of this quad
  const measured = Math.min(widthPx, heightPx) / Math.max(1, Math.max(widthPx, heightPx));
  let ratio = measured;
  let bestDelta = 0.12; // only snap when we are genuinely close
  for (const target of SHEET_ASPECTS) {
    const delta = Math.abs(measured - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      ratio = target;
    }
  }

  let outW: number;
  let outH: number;
  if (widthPx >= heightPx) {
    outW = widthPx;
    outH = Math.round(widthPx * ratio);
  } else {
    outH = heightPx;
    outW = Math.round(heightPx * ratio);
  }

  const shrink = Math.min(1, maxSide / Math.max(outW, outH, 1));
  return {
    width: Math.max(16, Math.round(outW * shrink)),
    height: Math.max(16, Math.round(outH * shrink)),
  };
}

function buildHomography(quad: [Point, Point, Point, Point], outW: number, outH: number) {
  const dst: Point[] = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ];
  const A: number[][] = [];
  const bv: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = dst[i];
    const { x: u, y: v } = quad[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    bv.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    bv.push(v);
  }
  return solve8(A, bv);
}

export interface WarpOptions {
  maxSide?: number;
  /** Called after each tile: 0..1 */
  onProgress?: (fraction: number) => void;
  /** Yield to the event loop between tiles. */
  yieldToUi?: boolean;
}

/**
 * Warp a quad onto a rectangle, in horizontal bands.
 *
 * The old implementation ran one 5.7-million-pixel loop on the main thread,
 * which locked the UI for seconds and made the crop feel broken. This version
 * renders ~64-row tiles and yields between them, so the interface stays
 * responsive and can show real progress.
 */
export async function warpPerspectiveAsync(
  source: HTMLCanvasElement,
  quad: [Point, Point, Point, Point],
  opts: WarpOptions = {}
): Promise<WarpResult> {
  const { maxSide = 2400, onProgress, yieldToUi = true } = opts;
  const { width: outW, height: outH } = warpSize(quad, maxSide);
  const h = buildHomography(quad, outW, outH);

  const sctx = source.getContext("2d", { alpha: false })!;
  const sdat = sctx.getImageData(0, 0, source.width, source.height).data;
  const SW = source.width;
  const SH = source.height;

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const octx = out.getContext("2d", { alpha: false })!;

  const BAND = Math.max(32, Math.min(96, Math.round(3_000_000 / Math.max(1, outW))));
  for (let y0 = 0; y0 < outH; y0 += BAND) {
    const bandH = Math.min(BAND, outH - y0);
    const odat = octx.createImageData(outW, bandH);
    const o = odat.data;

    for (let y = y0; y < y0 + bandH; y++) {
      const row = y - y0;
      for (let x = 0; x < outW; x++) {
        const acc = [0, 0, 0];
        let taps = 0;
        const den = h[6] * x + h[7] * y + 1;
        const u = (h[0] * x + h[1] * y + h[2]) / den;
        const v = (h[3] * x + h[4] * y + h[5]) / den;
        const oi = (row * outW + x) * 4;
        if (u < 0 || v < 0 || u >= SW - 1 || v >= SH - 1) {
          o[oi] = 255;
          o[oi + 1] = 255;
          o[oi + 2] = 255;
          o[oi + 3] = 255;
          continue;
        }
        /*
         * Supersample 2x2 and box-filter.
         *
         * A single bilinear tap aliases badly when the source is scaled down
         * (a phone capture is ~2600px wide, the page is ~2400): the high
         * frequency paper texture and text edges fold into the horizontal
         * banding that made scans look "messy" and striped. Four taps averaged
         * is only ~1.6x the cost and removes most of it.
         */
        for (let ch = 0; ch < 3; ch++) acc[ch] = 0;
        for (let sy = 0; sy < 2; sy++) {
          for (let sx = 0; sx < 2; sx++) {
            const uu = u + sx * 0.5;
            const vv = v + sy * 0.5;
            const xa = uu | 0;
            const ya = vv | 0;
            if (xa < 0 || ya < 0 || xa >= SW - 1 || ya >= SH - 1) continue;
            const fx = uu - xa;
            const fy = vv - ya;
            const i00 = (ya * SW + xa) * 4;
            const i10 = i00 + 4;
            const i01 = ((ya + 1) * SW + xa) * 4;
            const i11 = i01 + 4;
            for (let ch = 0; ch < 3; ch++) {
              const a = sdat[i00 + ch] * (1 - fx) + sdat[i10 + ch] * fx;
              const b = sdat[i01 + ch] * (1 - fx) + sdat[i11 + ch] * fx;
              acc[ch] += a * (1 - fy) + b * fy;
            }
            taps++;
          }
        }
        if (!taps) {
          o[oi] = 255;
          o[oi + 1] = 255;
          o[oi + 2] = 255;
          o[oi + 3] = 255;
          continue;
        }
        o[oi] = acc[0] / taps;
        o[oi + 1] = acc[1] / taps;
        o[oi + 2] = acc[2] / taps;
        o[oi + 3] = 255;
      }
    }
    octx.putImageData(odat, 0, y0);

    onProgress?.(Math.min(1, (y0 + bandH) / outH));
    if (yieldToUi) await new Promise((r) => setTimeout(r, 0));
  }

  return { canvas: out, width: outW, height: outH };
}

/** Synchronous wrapper (kept for callers that do not need progress). */
/**
 * Synchronous warp, kept for callers that cannot await.
 *
 * Delegates to the same supersampled sampler as the async version so both
 * produce identical pixels (the old copy here had its own single-tap bilinear
 * loop, which produced visibly striped output whenever the page was scaled).
 */
export function warpPerspective(
  source: HTMLCanvasElement,
  quad: [Point, Point, Point, Point],
  maxSide = 2400
): WarpResult {
  const { width: outW, height: outH } = warpSize(quad, maxSide);
  const h = buildHomography(quad, outW, outH);
  const sctx = source.getContext("2d", { alpha: false })!;
  const sdat = sctx.getImageData(0, 0, source.width, source.height).data;
  const SW = source.width;
  const SH = source.height;

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const octx = out.getContext("2d", { alpha: false })!;
  const odat = octx.createImageData(outW, outH);
  const o = odat.data;

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const den = h[6] * x + h[7] * y + 1;
      const u = (h[0] * x + h[1] * y + h[2]) / den;
      const v = (h[3] * x + h[4] * y + h[5]) / den;
      const oi = (y * outW + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let taps = 0;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const uu = u + sx * 0.5;
          const vv = v + sy * 0.5;
          const xa = uu | 0;
          const ya = vv | 0;
          if (xa < 0 || ya < 0 || xa >= SW - 1 || ya >= SH - 1) continue;
          const fx = uu - xa;
          const fy = vv - ya;
          const i00 = (ya * SW + xa) * 4;
          const i10 = i00 + 4;
          const i01 = ((ya + 1) * SW + xa) * 4;
          const i11 = i01 + 4;
          r += (sdat[i00] * (1 - fx) + sdat[i10] * fx) * (1 - fy) + (sdat[i01] * (1 - fx) + sdat[i11] * fx) * fy;
          g += (sdat[i00 + 1] * (1 - fx) + sdat[i10 + 1] * fx) * (1 - fy) + (sdat[i01 + 1] * (1 - fx) + sdat[i11 + 1] * fx) * fy;
          b += (sdat[i00 + 2] * (1 - fx) + sdat[i10 + 2] * fx) * (1 - fy) + (sdat[i01 + 2] * (1 - fx) + sdat[i11 + 2] * fx) * fy;
          taps++;
        }
      }
      if (!taps) {
        o[oi] = o[oi + 1] = o[oi + 2] = o[oi + 3] = 255;
        continue;
      }
      o[oi] = r / taps;
      o[oi + 1] = g / taps;
      o[oi + 2] = b / taps;
      o[oi + 3] = 255;
    }
  }
  octx.putImageData(odat, 0, 0);
  return { canvas: out, width: outW, height: outH };
}

/* ----------------------------------------------------------------- filters */

/**
 * Downscale a canvas into a fresh one (never mutates the source).
 * Used for cheap on-screen previews instead of re-encoding full-res bitmaps.
 */
export function downscaleCopy(source: HTMLCanvasElement, maxSide = 900): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(source.width * scale));
  c.height = Math.max(1, Math.round(source.height * scale));
  const ctx = c.getContext("2d", { alpha: false })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

/**
 * Apply a look to a copy, leaving `source` untouched.
 * Filters are always derived from the pristine capture, so switching between
 * them is idempotent — B&W can never destroy the colour data.
 */
export function applyScanFilterToCopy(source: HTMLCanvasElement, filter: ScanFilter): HTMLCanvasElement {
  return applyScanFilter(downscaleCopy(source, Math.max(source.width, source.height)), filter);
}

/** Rotate a canvas by 90/180/270 degrees, returning a new canvas. */
export function rotateCanvas(source: HTMLCanvasElement, degrees: number): HTMLCanvasElement {
  const d = ((degrees % 360) + 360) % 360;
  if (d === 0) return source;
  const swap = d === 90 || d === 270;
  const out = document.createElement("canvas");
  out.width = swap ? source.height : source.width;
  out.height = swap ? source.width : source.height;
  const ctx = out.getContext("2d", { alpha: false })!;
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return out;
}

/**
 * Preview of the page *as it will look after cropping*, produced without
 * distorting it.
 *
 * The crop stage shows the full capture so the user can drag the corners, but
 * the confirmation preview used to reuse a full-frame square-ish bitmap, which
 * made the page look squashed. This renders the source at the quad's real
 * aspect ratio and letterboxes it inside the viewfinder instead.
 */
export function cropPreviewUrl(
  source: HTMLCanvasElement,
  quad: [Point, Point, Point, Point],
  filter: ScanFilter,
  maxSide = 900,
  quality = 0.85
): string {
  // Undistorted aspect ratio of the selection.
  const [tl, tr, br, bl] = quad;
  const wTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const wBottom = Math.hypot(br.x - bl.x, br.y - bl.y);
  const hLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const hRight = Math.hypot(br.x - tr.x, br.y - tr.y);
  const aspect = Math.max(wTop, wBottom) / Math.max(1, Math.max(hLeft, hRight));

  const outW = Math.round(maxSide * Math.min(1, aspect));
  const outH = Math.max(1, Math.round(outW / Math.max(0.05, aspect)));
  const c = document.createElement("canvas");
  c.width = Math.max(1, outW);
  c.height = Math.max(1, outH);
  const ctx = c.getContext("2d", { alpha: false })!;
  ctx.imageSmoothingQuality = "high";
  // Draw the source scaled to the *same* aspect the crop will produce: no stretch.
  ctx.drawImage(source, 0, 0, c.width, c.height);
  applyScanFilter(c, filter);
  return c.toDataURL("image/jpeg", quality);
}

/**
 * Small JPEG data-URL of `source` with `filter` applied.
 * Filtering happens *after* downscaling, so this costs a few milliseconds even
 * for a 12-megapixel capture.
 */
export function filteredPreviewUrl(
  source: HTMLCanvasElement,
  filter: ScanFilter,
  maxSide = 900,
  quality = 0.85
): string {
  const small = downscaleCopy(source, maxSide);
  applyScanFilter(small, filter);
  return small.toDataURL("image/jpeg", quality);
}


/** Apply one of the scan looks in place. */
export function applyScanFilter(canvas: HTMLCanvasElement, filter: ScanFilter): HTMLCanvasElement {
  if (filter === "original") return canvas;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const n = canvas.width * canvas.height;

  if (filter === "bw") {
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
      hist[l]++;
    }
    const t = Math.min(235, Math.max(110, otsu(hist, n) - 6));
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const v = l > t ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  } else if (filter === "gray") {
    let min = 255;
    let max = 0;
    const gray = new Uint8ClampedArray(n);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
      gray[p] = l;
      if (l < min) min = l;
      if (l > max) max = l;
    }
    const span = Math.max(1, max - min);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const v = ((gray[p] - min) / span) * 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  } else if (filter === "vivid") {
    /*
     * Contrast enhancement with a brightness guard.
     *
     * Most photos are dark ink on a light page, and stretching the luminance
     * across the full range makes those crisp. A dark original — black business
     * card, chalkboard, night-mode screen — occupies a narrow dark band, and the
     * same stretch drove its background to pure black with blown-out white
     * text, which read as an inversion and looked broken. So measure the median
     * first: light originals get the full stretch, dark ones are levelled inside
     * their own range and lifted off pure black instead.
     */
    const samples: number[] = [];
    const step = Math.max(1, Math.floor(n / 5000));
    for (let p = 0; p < n; p += step) {
      const i = p * 4;
      samples.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    }
    samples.sort((a, b) => a - b);
    const pick = (q: number) =>
      samples[Math.min(samples.length - 1, Math.max(0, Math.round(q * (samples.length - 1))))];
    const median = pick(0.5);
    const darkOriginal = median < 110;
    const lo = pick(0.02);
    const hi = pick(0.98);
    const inset = (hi - lo) * 0.05;
    const span = Math.max(40, darkOriginal ? hi - lo : hi - lo - inset * 2);
    const outLo = darkOriginal ? 38 : 0;
    const outSpan = darkOriginal ? 200 : 255;
    const sat = darkOriginal ? 1.15 : 1.03;

    for (let i = 0; i < d.length; i += 4) {
      const r0 = d[i];
      const g0 = d[i + 1];
      const b0 = d[i + 2];
      const l = 0.299 * r0 + 0.587 * g0 + 0.114 * b0;
      const from = darkOriginal ? lo : lo + inset;
      const t = Math.min(1, Math.max(0, (l - from) / span));
      const grey = outLo + t * outSpan;
      const gain = l > 1 ? grey / l : 1;
      // colour ratio preserved, then a small saturation nudge around the new grey
      const rr = r0 * gain;
      const gg = g0 * gain;
      const bb = b0 * gain;
      d[i] = Math.min(255, Math.max(0, grey + (rr - grey) * sat));
      d[i + 1] = Math.min(255, Math.max(0, grey + (gg - grey) * sat));
      d[i + 2] = Math.min(255, Math.max(0, grey + (bb - grey) * sat));
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function canvasToDataUrl(canvas: HTMLCanvasElement, quality = 0.9): string {
  return canvas.toDataURL("image/jpeg", quality);
}

/* ------------------------------------------------------------ smart erase */

/** Average colour of the ring just outside a rect — used as the eraser ink. */
export function sampleBorderColor(canvas: HTMLCanvasElement, rect: { x: number; y: number; w: number; h: number }) {
  const ctx = canvas.getContext("2d", { alpha: false })!;
  const pad = 6;
  const samples: [number, number][] = [];
  const step = 4;
  const x0 = Math.max(0, rect.x - pad);
  const y0 = Math.max(0, rect.y - pad);
  const x1 = Math.min(canvas.width - 1, rect.x + rect.w + pad);
  const y1 = Math.min(canvas.height - 1, rect.y + rect.h + pad);
  for (let x = x0; x <= x1; x += step) {
    samples.push([x, y0], [x, y1]);
  }
  for (let y = y0; y <= y1; y += step) {
    samples.push([x0, y], [x1, y]);
  }
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (const [x, y] of samples) {
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
    const d = ctx.getImageData(x, y, 1, 1).data;
    r += d[0];
    g += d[1];
    b += d[2];
    count++;
  }
  if (!count) return "#ffffff";
  const hex = (v: number) => Math.round(v / count).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Put a canvas behind a data URL so we can sample it later. */
export async function dataUrlToCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("image load failed"));
    i.src = dataUrl;
  });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d", { alpha: false })!.drawImage(img, 0, 0);
  return c;
}
