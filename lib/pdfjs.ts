"use client";

/**
 * Thin wrapper around pdf.js.
 * - loaded lazily so it never runs during SSR / static prerender
 * - all assets (worker, cmaps, fonts, wasm) are served from /public, no CDN
 */

export type PdfJs = typeof import("pdfjs-dist");
export type PdfDocumentProxy = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;
export type PdfPageProxy = Awaited<ReturnType<PdfDocumentProxy["getPage"]>>;

let pdfjsPromise: Promise<PdfJs> | null = null;

export async function getPdfjs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((m) => {
      m.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      return m;
    });
  }
  return pdfjsPromise;
}

export const PDFJS_DOC_PARAMS = {
  cMapUrl: "/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/standard_fonts/",
  wasmUrl: "/pdf-wasm/",
  isEvalSupported: false,
} as const;

export async function openPdf(bytes: Uint8Array): Promise<PdfDocumentProxy> {
  const pdfjs = await getPdfjs();
  // pdf.js transfers (detaches) the buffer it is given, so always hand it a copy.
  const data = new Uint8Array(bytes);
  return pdfjs.getDocument({ data, ...PDFJS_DOC_PARAMS }).promise;
}

export interface RenderedPage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Render a page onto an existing canvas at the requested scale × devicePixelRatio. */
export async function renderPageToCanvas(
  page: PdfPageProxy,
  canvas: HTMLCanvasElement,
  scale: number,
  opts: { dpr?: number; rotation?: number } = {}
) {
  const dpr = opts.dpr ?? 1;
  const viewport = page.getViewport({ scale, rotation: opts.rotation ?? page.rotate });
  canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
  canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Could not acquire 2d context");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvas,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    intent: "display",
  } as Parameters<PdfPageProxy["render"]>[0]).promise;
  return { ctx, viewport };
}

/** Render a page to a fresh canvas (used for thumbnails, export & compression). */
export async function renderPageToNewCanvas(
  page: PdfPageProxy,
  scale: number,
  opts: { dpr?: number; rotation?: number } = {}
): Promise<HTMLCanvasElement> {
  const dpr = opts.dpr ?? 1;
  const viewport = page.getViewport({ scale, rotation: opts.rotation ?? page.rotate });
  const canvas = makeCanvas(viewport.width * dpr, viewport.height * dpr);
  const ctx = canvas.getContext("2d", { alpha: false })!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvas,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    intent: "display",
  } as Parameters<PdfPageProxy["render"]>[0]).promise;
  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement, mime = "image/jpeg", quality = 0.85): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas encoding failed"))), mime, quality);
  });
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

export async function dataUrlToBytes(dataUrl: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || "image/jpeg" };
}
