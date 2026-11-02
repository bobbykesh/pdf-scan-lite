"use client";

import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";
import type { Annotation, PageMeta } from "@/types";
import { pageToExportImage } from "./stamp";
import { displaySize, formatBytes } from "./utils";
import { buildPdfFromImages } from "./pdfedit";

export interface CompressOptions {
  dpi: number;
  quality: number;
  format: "jpeg" | "png";
}

export interface CompressResult {
  bytes: Uint8Array;
  before: number;
  after: number;
  pages: number;
}

/**
 * Rasterise every page at the chosen DPI/quality and rebuild the PDF.
 * This is the heavy hitter: a 20 MB phone scan usually lands at 1–3 MB.
 */
export async function compressPdf(
  pages: PageMeta[],
  annotations: Record<string, Annotation[]>,
  opts: CompressOptions,
  onProgress?: (done: number, total: number) => void
): Promise<CompressResult> {
  const images: { dataUrl: string; wPt: number; hPt: number }[] = [];
  for (let i = 0; i < pages.length; i++) {
    const meta = pages[i];
    const { dataUrl } = await pageToExportImage(meta, {
      dpi: opts.dpi,
      annotations: annotations[meta.id] ?? [],
      quality: opts.quality,
      format: opts.format,
    });
    const { w, h } = displaySize(meta);
    images.push({ dataUrl, wPt: w, hPt: h });
    onProgress?.(i + 1, pages.length);
  }
  const bytes = await buildPdfFromImages(images);
  return { bytes, before: 0, after: bytes.byteLength, pages: pages.length };
}

/** Lossless-ish re-save: drops unused objects, packs object streams. */
export async function resavePdf(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}

/** PDF → images, one file per page, zipped. */
export async function pdfToImagesZip(
  pages: PageMeta[],
  annotations: Record<string, Annotation[]>,
  opts: { dpi: number; quality: number; format: "png" | "jpeg" },
  baseName: string,
  onProgress?: (done: number, total: number) => void
): Promise<Blob> {
  const zip = new JSZip();
  const folder = zip.folder(sanitizeName(baseName) || "pages") ?? zip;
  const ext = opts.format === "png" ? "png" : "jpg";
  for (let i = 0; i < pages.length; i++) {
    const { blob } = await pageToExportImage(pages[i], {
      dpi: opts.dpi,
      annotations: annotations[pages[i].id] ?? [],
      quality: opts.quality,
      format: opts.format,
    });
    folder.file(`page-${String(i + 1).padStart(2, "0")}.${ext}`, blob);
    onProgress?.(i + 1, pages.length);
  }
  return zip.generateAsync({ type: "blob", compression: "STORE" });
}

export function sanitizeName(name: string) {
  return name.replace(/[^\w\-. ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60);
}

export { formatBytes };
