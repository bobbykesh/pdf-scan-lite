"use client";

/**
 * Holds the loaded source PDFs (bytes + pdf.js documents) outside React state,
 * and renders pages at a given raster size with a small in-memory cache.
 * Keeping raw bytes out of component state avoids copying megabytes around.
 */
import { openPdf, renderPageToNewCanvas } from "./pdfjs";
import type { PdfDocumentProxy } from "./pdfjs";
import type { PdfDocRef, PageMeta, Rotation } from "@/types";
import { displaySize } from "./utils";

interface DocEntry {
  ref: PdfDocRef;
  proxy: Promise<PdfDocumentProxy>;
}

class PdfStore {
  private docs = new Map<string, DocEntry>();
  private cache = new Map<string, HTMLCanvasElement>();

  add(ref: PdfDocRef) {
    if (this.docs.has(ref.id)) return this.docs.get(ref.id)!.proxy;
    const proxy = openPdf(ref.bytes);
    this.docs.set(ref.id, { ref, proxy });
    return proxy;
  }

  get(id: string) {
    return this.docs.get(id)?.proxy ?? null;
  }

  refs(): PdfDocRef[] {
    return [...this.docs.values()].map((d) => d.ref);
  }

  has(id: string) {
    return this.docs.has(id);
  }

  async pageCount(id: string) {
    const p = this.get(id);
    return p ? (await p).numPages : 0;
  }

  /** Total bytes of the source PDFs currently open (ignores image sources). */
  totalSourceBytes() {
    let n = 0;
    for (const d of this.docs.values()) n += d.ref.bytes.byteLength;
    return n;
  }

  clear() {
    this.docs.clear();
    this.cache.clear();
  }

  /** Rasterise a page. `maxSide` keeps the cache resolution bounded. */
  async render(meta: PageMeta, maxSide: number): Promise<HTMLCanvasElement> {
    if (meta.source.kind !== "pdf") throw new Error("not a pdf page");
    const src = meta.source;
    const rot = ((src.pdfRotation + meta.rotation) % 360) as Rotation;
    const key = `${src.docId}:${src.index}:${rot}:${maxSide}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    const proxyP = this.get(src.docId);
    if (!proxyP) throw new Error("source pdf missing");
    const proxy = await proxyP;
    const page = await proxy.getPage(src.index + 1);
    const vp = page.getViewport({ scale: 1, rotation: rot });
    const scale = maxSide / Math.max(vp.width, vp.height);
    const canvas = await renderPageToNewCanvas(page, scale, { rotation: rot });
    if (this.cache.size > 24) {
      // drop the oldest entry — pages are re-rendered on demand anyway
      const first = this.cache.keys().next().value;
      if (first) this.cache.delete(first);
    }
    this.cache.set(key, canvas);
    return canvas;
  }

  /** Render at a precise pixel width (used for export/OCR/compression). */
  async renderAtDpi(meta: PageMeta, dpi: number): Promise<HTMLCanvasElement> {
    if (meta.source.kind !== "pdf") throw new Error("not a pdf page");
    const src = meta.source;
    const rot = ((src.pdfRotation + meta.rotation) % 360) as Rotation;
    const proxyP = this.get(src.docId);
    if (!proxyP) throw new Error("source pdf missing");
    const proxy = await proxyP;
    const page = await proxy.getPage(src.index + 1);
    return renderPageToNewCanvas(page, dpi / 72, { rotation: rot });
  }

  sizeOf(meta: PageMeta) {
    return displaySize(meta);
  }
}

export const pdfStore = new PdfStore();
