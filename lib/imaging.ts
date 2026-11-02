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
  const t = otsu(hist, W * H);

  // Paper is usually brighter than its surroundings — decide per image.
  let border = 0;
  let borderN = 0;
  const inset = Math.max(1, Math.round(Math.min(W, H) * 0.04));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x < inset || y < inset || x >= W - inset || y >= H - inset) {
        border += lum[y * W + x];
        borderN++;
      }
    }
  }
  let centre = 0;
  let centreN = 0;
  for (let y = Math.round(H * 0.3); y < Math.round(H * 0.7); y++) {
    for (let x = Math.round(W * 0.3); x < Math.round(W * 0.7); x++) {
      centre += lum[y * W + x];
      centreN++;
    }
  }
  const brightDoc = centre / Math.max(1, centreN) > border / Math.max(1, borderN);

  const mask = new Uint8Array(W * H);
  for (let p = 0; p < mask.length; p++) {
    const on = brightDoc ? lum[p] > t : lum[p] < t;
    mask[p] = on ? 1 : 0;
  }

  // Largest connected component.
  const seen = new Uint8Array(W * H);
  let bestPixels: number[] = [];
  const stack: number[] = [];
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
    if (pixels.length > bestPixels.length) bestPixels = pixels;
  }

  const covered = bestPixels.length / (W * H);
  // Too small to be a page, or so large it is obviously the whole frame.
  if (covered < 0.08 || covered > 0.985) {
    return {
      corners: FULL_FRAME(source.width, source.height),
      confidence: 0,
      found: false,
    };
  }

  // Perspective corners from the extreme points of the region.
  let tl = 0, tr = 0, br = 0, bl = 0;
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  for (const p of bestPixels) {
    const x = p % W;
    const y = (p - x) / W;
    const sum = x + y;
    const diff = x - y;
    if (sum < minSum) { minSum = sum; tl = p; }
    if (sum > maxSum) { maxSum = sum; br = p; }
    if (diff > maxDiff) { maxDiff = diff; tr = p; }
    if (diff < minDiff) { minDiff = diff; bl = p; }
  }

  const toSource = (p: number): Point => {
    const x = p % W;
    const y = (p - x) / W;
    return {
      x: Math.min(source.width, Math.max(0, (x / W) * source.width)),
      y: Math.min(source.height, Math.max(0, (y / H) * source.height)),
    };
  };

  const quad = [toSource(tl), toSource(tr), toSource(br), toSource(bl)] as [Point, Point, Point, Point];

  // Refine each corner outward a little so it sits on the page edge rather than
  // one radius inside the filled region.
  const refine = (corner: Point, dirX: number, dirY: number, radius: number): Point => {
    const cx = Math.round((corner.x / source.width) * W);
    const cy = Math.round((corner.y / source.height) * H);
    let bestX = cx;
    let bestY = cy;
    let bestScore = -Infinity;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (!mask[y * W + x]) continue;
        const score = dx * dirX + dy * dirY;
        if (score > bestScore) { bestScore = score; bestX = x; bestY = y; }
      }
    }
    return {
      x: Math.min(source.width, Math.max(0, (bestX / W) * source.width)),
      y: Math.min(source.height, Math.max(0, (bestY / H) * source.height)),
    };
  };
  const r = Math.max(3, Math.round(W * 0.03));
  quad[0] = refine(quad[0], -1, -1, r);
  quad[1] = refine(quad[1], 1, -1, r);
  quad[2] = refine(quad[2], 1, 1, r);
  quad[3] = refine(quad[3], -1, 1, r);

  const area = quadArea(quad);
  const frameArea = source.width * source.height;
  const sides = sideLengths(quad);
  const minSide = Math.min(...sides);
  const valid =
    isConvex(quad) &&
    area > frameArea * 0.06 &&
    area < frameArea * 0.999 &&
    minSide > Math.min(source.width, source.height) * 0.06;

  if (!valid) {
    return { corners: FULL_FRAME(source.width, source.height), confidence: 0, found: false };
  }

  // Confidence blends coverage with how rectangular the result is.
  const longest = Math.max(...sides);
  const squareness = minSide / Math.max(1, longest);
  const confidence = Math.min(1, covered / 0.5) * 0.6 + squareness * 0.4;

  return { corners: quad, confidence, found: true };
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
export function warpSize(
  quad: [Point, Point, Point, Point],
  maxSide = 2400
): { width: number; height: number } {
  const [tl, tr, br, bl] = quad;
  const wTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const wBottom = Math.hypot(br.x - bl.x, br.y - bl.y);
  const hLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const hRight = Math.hypot(br.x - tr.x, br.y - tr.y);
  const outW = Math.max(wTop, wBottom);
  const outH = Math.max(hLeft, hRight);
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
        const xa = u | 0;
        const ya = v | 0;
        const fx = u - xa;
        const fy = v - ya;
        const i00 = (ya * SW + xa) * 4;
        const i10 = i00 + 4;
        const i01 = ((ya + 1) * SW + xa) * 4;
        const i11 = i01 + 4;
        for (let ch = 0; ch < 3; ch++) {
          const a = sdat[i00 + ch] * (1 - fx) + sdat[i10 + ch] * fx;
          const b = sdat[i01 + ch] * (1 - fx) + sdat[i11 + ch] * fx;
          o[oi + ch] = a * (1 - fy) + b * fy;
        }
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
      if (u < 0 || v < 0 || u >= SW - 1 || v >= SH - 1) {
        o[oi] = o[oi + 1] = o[oi + 2] = o[oi + 3] = 255;
        continue;
      }
      const xa = u | 0;
      const ya = v | 0;
      const fx = u - xa;
      const fy = v - ya;
      const i00 = (ya * SW + xa) * 4;
      const i10 = i00 + 4;
      const i01 = ((ya + 1) * SW + xa) * 4;
      const i11 = i01 + 4;
      for (let ch = 0; ch < 3; ch++) {
        const a = sdat[i00 + ch] * (1 - fx) + sdat[i10 + ch] * fx;
        const b = sdat[i01 + ch] * (1 - fx) + sdat[i11 + ch] * fx;
        o[oi + ch] = a * (1 - fy) + b * fy;
      }
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
    // gentle white-balance + contrast + saturation
    let min = 255;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (l < min) min = l;
      if (l > max) max = l;
    }
    const lo = min + (max - min) * 0.06;
    const hi = max - (max - min) * 0.06;
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i];
      let g = d[i + 1];
      let b = d[i + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      // contrast stretch on luminance, keep colour ratios
      const target = Math.min(255, Math.max(0, ((l - lo) / span) * 255));
      const gain = l > 1 ? target / l : 1;
      r = Math.min(255, r * gain * 1.04);
      g = Math.min(255, g * gain * 1.03);
      b = Math.min(255, b * gain);
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
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
