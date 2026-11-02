"use client";

import type { PdfDocRef, PageMeta, Rotation } from "@/types";
import { fitA4, round, uid } from "./utils";
import { openPdf, renderPageToNewCanvas, loadImage } from "./pdfjs";
import { pdfStore } from "./pdfStore";

export const isPdfFile = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
export const isImageFile = (f: File) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|bmp)$/i.test(f.name);

export function readFileBytes(file: File): Promise<Uint8Array> {
  return file.arrayBuffer().then((b) => new Uint8Array(b));
}

export function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Register a PDF (bytes) with the store and produce one PageMeta per page. */
export async function importPdf(bytes: Uint8Array, name: string): Promise<{ ref: PdfDocRef; pages: PageMeta[] }> {
  const ref: PdfDocRef = { id: uid("doc"), name, bytes };
  const proxy = await pdfStore.add(ref);
  const pages: PageMeta[] = [];
  for (let i = 0; i < proxy.numPages; i++) {
    const page = await proxy.getPage(i + 1);
    const vp = page.getViewport({ scale: 1, rotation: 0 }); // physical, unrotated
    pages.push({
      id: uid("pg"),
      source: { kind: "pdf", docId: ref.id, index: i, pdfRotation: ((page.rotate % 360) + 360) % 360 as Rotation },
      wPt: round(vp.width, 2),
      hPt: round(vp.height, 2),
      rotation: 0,
      ocrState: "idle",
    });
  }
  return { ref, pages };
}

/** Images become full-bleed pages, A4 fit, portrait or landscape by aspect. */
export async function pageFromImage(dataUrl: string, mime = "image/jpeg"): Promise<PageMeta> {
  const img = await loadImage(dataUrl);
  const fit = fitA4(img.naturalWidth, img.naturalHeight);
  return {
    id: uid("pg"),
    source: { kind: "image", dataUrl, mime },
    wPt: fit.wPt,
    hPt: fit.hPt,
    rotation: 0,
    ocrState: "idle",
  };
}

export async function thumbnailFor(meta: PageMeta, maxSide = 260): Promise<string> {
  let canvas: HTMLCanvasElement;
  if (meta.source.kind === "pdf") {
    canvas = await pdfStore.render(meta, maxSide);
  } else {
    const img = await loadImage(meta.source.dataUrl);
    const swap = meta.rotation % 180 !== 0;
    const sw = swap ? img.naturalHeight : img.naturalWidth;
    const sh = swap ? img.naturalWidth : img.naturalHeight;
    const scale = maxSide / Math.max(sw, sh);
    canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext("2d", { alpha: false })!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((((meta.rotation % 360) + 360) % 360) * (Math.PI / 180));
    const dw = swap ? canvas.height : canvas.width;
    const dh = swap ? canvas.width : canvas.height;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }
  return canvas.toDataURL("image/jpeg", 0.72);
}

const BLANK_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

export function makeBlankPage(w = 595.28, h = 841.89): PageMeta {
  return {
    id: uid("pg"),
    source: { kind: "image", dataUrl: BLANK_PNG, mime: "image/png" },
    wPt: round(w, 2),
    hPt: round(h, 2),
    rotation: 0,
    ocrState: "idle",
  };
}

/** Open a PDF with pdf.js only (no page metas) — used for rasterising encrypted files. */
export async function openRawPdf(bytes: Uint8Array) {
  return openPdf(bytes);
}

export { renderPageToNewCanvas };
