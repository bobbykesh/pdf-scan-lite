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
export async function captureFrame(video: HTMLVideoElement, track?: MediaStreamTrack): Promise<HTMLCanvasElement> {
  type ImageCaptureCtor = new (t: MediaStreamTrack) => { takePhoto: () => Promise<Blob> };
  const IC = (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
  if (IC && track) {
    try {
      const cap = new IC(track);
      const blob = await cap.takePhoto();
      const bmp = await createImageBitmap(blob);
      return canvasFromImage(bmp);
    } catch {
      /* fall through to video frame */
    }
  }
  const w = video.videoWidth || 1920;
  const h = video.videoHeight || 1080;
  return canvasFromImage({ width: w, height: h, close: undefined } as unknown as ImageBitmap);
}

export function videoFrameCanvas(video: HTMLVideoElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = video.videoWidth || 1920;
  c.height = video.videoHeight || 1080;
  const ctx = c.getContext("2d", { alpha: false })!;
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
export function detectDocumentCorners(source: HTMLCanvasElement): [Point, Point, Point, Point] {
  const W = 200;
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

  // polarity: compare border ring with the centre
  let border = 0;
  let borderN = 0;
  const inset = Math.max(1, Math.round(Math.min(W, H) * 0.03));
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
  for (let p = 0; p < mask.length; p++) mask[p] = brightDoc ? (lum[p] > t ? 1 : 0) : lum[p] < t ? 1 : 0;

  // largest connected component (4-neighbour flood fill)
  const seen = new Uint8Array(W * H);
  let best = { area: 0, minX: 0, minY: 0, maxX: W - 1, maxY: H - 1 };
  const stack: number[] = [];
  for (let p0 = 0; p0 < mask.length; p0++) {
    if (!mask[p0] || seen[p0]) continue;
    let area = 0;
    let minX = W;
    let minY = H;
    let maxX = 0;
    let maxY = 0;
    stack.length = 0;
    stack.push(p0);
    seen[p0] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W;
      const y = (p - x) / W;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
      for (const n of nb) {
        if (n >= 0 && mask[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (area > best.area) best = { area, minX, minY, maxX, maxY };
  }

  const covered = best.area > 0 ? best.area / (W * H) : 0;
  // if nothing sensible was found (or the "sheet" is tiny), fall back to full frame
  if (covered < 0.12) {
    return [
      { x: 0, y: 0 },
      { x: source.width, y: 0 },
      { x: source.width, y: source.height },
      { x: 0, y: source.height },
    ];
  }

  // refine each side with the strongest horizontal / vertical gradients nearby
  const colEdge = new Float32Array(W);
  const rowEdge = new Float32Array(H);
  for (let y = 1; y < H; y++) {
    for (let x = 1; x < W; x++) {
      const gx = Math.abs(lum[y * W + x] - lum[y * W + x - 1]);
      const gy = Math.abs(lum[y * W + x] - lum[(y - 1) * W + x]);
      if (gx > 18) colEdge[x] += gx;
      if (gy > 18) rowEdge[y] += gy;
    }
  }
  const peak = (arr: Float32Array, centreIdx: number, span: number) => {
    let bi = -1;
    let bv = 0;
    for (let i = Math.max(1, Math.round(centreIdx - span)); i <= Math.min(arr.length - 2, Math.round(centreIdx + span)); i++) {
      if (arr[i] > bv) {
        bv = arr[i];
        bi = i;
      }
    }
    return bi < 0 ? Math.round(centreIdx) : bi;
  };
  const spanX = Math.max(3, Math.round(W * 0.035));
  const spanY = Math.max(3, Math.round(H * 0.035));
  const left = peak(colEdge, best.minX, spanX);
  const right = peak(colEdge, best.maxX, spanX);
  const top = peak(rowEdge, best.minY, spanY);
  const bottom = peak(rowEdge, best.maxY, spanY);

  const sx = source.width / W;
  const sy = source.height / H;
  const clampX = (v: number) => Math.min(source.width, Math.max(0, v * sx));
  const clampY = (v: number) => Math.min(source.height, Math.max(0, v * sy));
  const x0 = clampX(Math.min(left, right));
  const x1 = clampX(Math.max(left, right));
  const y0 = clampY(Math.min(top, bottom));
  const y1 = clampY(Math.max(top, bottom));
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
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

/**
 * Warp the quadrilateral `quad` (source pixels: TL, TR, BR, BL) onto a
 * rectangular canvas, using inverse homography + bilinear sampling.
 */
export function warpPerspective(
  source: HTMLCanvasElement,
  quad: [Point, Point, Point, Point],
  maxSide = 2400
): WarpResult {
  const [tl, tr, br, bl] = quad;
  const wTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const wBottom = Math.hypot(br.x - bl.x, br.y - bl.y);
  const hLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const hRight = Math.hypot(br.x - tr.x, br.y - tr.y);
  let outW = Math.round(Math.max(wTop, wBottom));
  let outH = Math.round(Math.max(hLeft, hRight));
  const shrink = Math.min(1, maxSide / Math.max(outW, outH));
  outW = Math.max(16, Math.round(outW * shrink));
  outH = Math.max(16, Math.round(outH * shrink));

  // homography mapping destination (x,y) -> source (u,v)
  const dst: Point[] = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ];
  const src = [tl, tr, br, bl];
  const A: number[][] = [];
  const bv: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = dst[i];
    const { x: u, y: v } = src[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    bv.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    bv.push(v);
  }
  const h = solve8(A, bv);

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
        o[oi] = 255;
        o[oi + 1] = 255;
        o[oi + 2] = 255;
        o[oi + 3] = 255;
        continue;
      }
      const x0 = u | 0;
      const y0 = v | 0;
      const fx = u - x0;
      const fy = v - y0;
      const i00 = (y0 * SW + x0) * 4;
      const i10 = i00 + 4;
      const i01 = ((y0 + 1) * SW + x0) * 4;
      const i11 = i01 + 4;
      for (let ch = 0; ch < 3; ch++) {
        const a = sdat[i00 + ch] * (1 - fx) + sdat[i10 + ch] * fx;
        const bb = sdat[i01 + ch] * (1 - fx) + sdat[i11 + ch] * fx;
        o[oi + ch] = a * (1 - fy) + bb * fy;
      }
      o[oi + 3] = 255;
    }
  }
  octx.putImageData(odat, 0, 0);
  return { canvas: out, width: outW, height: outH };
}

/* ----------------------------------------------------------------- filters */

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
