"use client";

/**
 * Export pipeline: turns the in-memory document (pages + annotations) into a
 * brand new PDF with pdf-lib. Every overlay is converted from HTML/CSS screen
 * coordinates (top-left origin, y down) into native PDF vector space
 * (bottom-left origin, y up), including pages the user rotated.
 */
import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, degrees, rgb, BlendMode } from "pdf-lib";
import type { Annotation, DrawAnn, FontKey, PageMeta, Rotation, TextAnn } from "@/types";
import { displaySize, hexToRgb } from "./utils";
import { dataUrlToBytes } from "./pdfjs";

export interface PdfSourceRef {
  id: string;
  bytes: Uint8Array;
}

export interface ExportPage {
  meta: PageMeta;
  annotations: Annotation[];
}

export interface ExportOptions {
  /** write the recognised words as an invisible text layer (searchable / copyable) */
  flattenOcr: boolean;
  /** bake annotations in; if false only redactions are baked */
  flattenAnnotations: boolean;
}

const FONT_MAP: Record<FontKey, StandardFonts> = {
  helvetica: StandardFonts.Helvetica,
  "helvetica-bold": StandardFonts.HelveticaBold,
  times: StandardFonts.TimesRoman,
  "times-bold": StandardFonts.TimesRomanBold,
  courier: StandardFonts.Courier,
};

export const FONT_CSS: Record<FontKey, string> = {
  helvetica: "Helvetica, Arial, sans-serif",
  "helvetica-bold": "Helvetica, Arial, sans-serif",
  times: "'Times New Roman', Times, serif",
  "times-bold": "'Times New Roman', Times, serif",
  courier: "'Courier New', monospace",
};

/** display-space rect (y down, rotated) -> unrotated PDF-space rect (y up) */
function toPdfRect(
  rect: { x: number; y: number; w: number; h: number },
  pageW: number,
  pageH: number,
  rotation: Rotation
) {
  const flipped = { x: rect.x, y: pageH - rect.y - rect.h, w: rect.w, h: rect.h };
  return rotateRectLocal(flipped, pageW, pageH, rotation);
}

function rotateRectLocal(r: { x: number; y: number; w: number; h: number }, w: number, h: number, rot: Rotation) {
  if (rot === 0) return { ...r };
  if (rot === 180) return { x: w - r.x - r.w, y: h - r.y - r.h, w: r.w, h: r.h };
  if (rot === 90) return { x: h - r.y - r.h, y: r.x, w: r.h, h: r.w };
  return { x: r.y, y: w - r.x - r.w, w: r.h, h: r.w };
}

/** display-space point -> unrotated PDF-space point */
function toPdfPoint(p: { x: number; y: number }, pageW: number, pageH: number, rotation: Rotation) {
  const r = rotateRectLocal({ x: p.x, y: pageH - p.y, w: 0, h: 0 }, pageW, pageH, rotation);
  return { x: r.x, y: r.y };
}

export interface BuiltPdf {
  bytes: Uint8Array;
  pageCount: number;
  ocrPages: number;
  bakedAnnotations: number;
  skippedPages: number;
}

export async function exportPdf(
  pages: ExportPage[],
  sources: PdfSourceRef[],
  opts: ExportOptions
): Promise<BuiltPdf> {
  const out = await PDFDocument.create();
  const fonts = new Map<FontKey, PDFFont>();
  const imageCache = new Map<string, PDFImage>();

  const getFont = async (key: FontKey) => {
    let f = fonts.get(key);
    if (!f) {
      f = await out.embedFont(FONT_MAP[key] ?? StandardFonts.Helvetica);
      fonts.set(key, f);
    }
    return f;
  };

  const getImage = async (dataUrl: string) => {
    const cached = imageCache.get(dataUrl);
    if (cached) return cached;
    const { bytes, mime } = await dataUrlToBytes(dataUrl);
    const img = mime.includes("png") ? await out.embedPng(bytes) : await out.embedJpg(bytes);
    imageCache.set(dataUrl, img);
    return img;
  };

  const srcDocs = new Map<string, PDFDocument>();
  for (const s of sources) {
    try {
      srcDocs.set(s.id, await PDFDocument.load(s.bytes, { ignoreEncryption: true, updateMetadata: false }));
    } catch {
      /* encrypted / malformed — such pages are re-rasterised by the caller */
    }
  }

  const bakeAll = opts.flattenAnnotations;
  let baked = 0;
  let ocrPages = 0;
  let skipped = 0;

  for (const { meta, annotations } of pages) {
    let page: PDFPage;

    if (meta.source.kind === "pdf") {
      const src = srcDocs.get(meta.source.docId);
      if (!src) {
        skipped++;
        continue;
      }
      const [copied] = await out.copyPages(src, [meta.source.index]);
      page = out.addPage(copied);
      const base = page.getRotation().angle;
      page.setRotation(degrees((base + meta.rotation) % 360));
    } else {
      const img = await getImage(meta.source.dataUrl);
      page = out.addPage([meta.wPt, meta.hPt]);
      page.drawImage(img, { x: 0, y: 0, width: meta.wPt, height: meta.hPt });
      page.setRotation(degrees(meta.rotation % 360));
    }

    const { width: pw, height: ph } = page.getSize();

    for (const ann of annotations) {
      // redactions and eraser strokes are always honoured: pixel-destructive edits
      const destructive = ann.type === "redact" || (ann.type === "draw" && ann.kind === "erase");
      if (!bakeAll && !destructive) continue;
      baked++;
      if (ann.type === "redact") {
        const r = toPdfRect(ann.rect, pw, ph, meta.rotation);
        const c = hexToRgb(ann.color || "#ffffff");
        page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: rgb(c.r, c.g, c.b) });
      } else if (ann.type === "text") {
        await drawText(page, ann, pw, ph, meta.rotation, getFont);
      } else if (ann.type === "image") {
        const img = await getImage(ann.dataUrl);
        const r = toPdfRect(ann.rect, pw, ph, meta.rotation);
        page.drawImage(img, { x: r.x, y: r.y, width: r.w, height: r.h, opacity: ann.opacity ?? 1 });
      } else if (ann.type === "draw") {
        drawStroke(page, ann, pw, ph, meta.rotation);
      }
    }

    // Words the user replaced/deleted must not survive as recoverable text or
    // pixels: cover them with an opaque white box (true redaction) in vector space.
    const erasedWords = meta.ocr?.words?.filter((w) => w.conf === -1) ?? [];
    for (const word of erasedWords) {
      const pad = Math.max(1, word.h * 0.12);
      const r = toPdfRect(
        { x: word.x - pad, y: word.y - pad, w: word.w + pad * 2, h: word.h + pad * 2 },
        pw,
        ph,
        meta.rotation
      );
      page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: rgb(1, 1, 1) });
    }

    if (opts.flattenOcr && meta.ocr?.words?.length) {
      await drawOcrLayer(page, meta, pw, ph);
      ocrPages++;
    }
  }

  out.setProducer("PDF Scan Lite");
  out.setCreator("PDF Scan Lite — client-side scanner & editor");
  out.setCreationDate(new Date());
  const bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
  return { bytes, pageCount: out.getPageCount(), ocrPages, bakedAnnotations: baked, skippedPages: skipped };
}

async function drawText(
  page: PDFPage,
  ann: TextAnn,
  pw: number,
  ph: number,
  rotation: Rotation,
  getFont: (k: FontKey) => Promise<PDFFont>
) {
  const font = await getFont(ann.fontKey || "helvetica");
  const size = Math.max(1, ann.fontSize || 12);
  const lineHeight = size * (ann.lineHeight || 1.25);
  const c = hexToRgb(ann.color || "#111111");
  const maxWidth = Math.max(size * 2, ann.rect.w);

  const lines: string[] = [];
  for (const raw of (ann.text || "").split("\n")) {
    if (!raw) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of raw.split(/(\s+)/)) {
      const test = line + word;
      if (font.widthOfTextAtSize(test, size) > maxWidth && line.trim()) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else line = test;
    }
    lines.push(line.trimEnd());
  }

  lines.forEach((line, i) => {
    if (!line) return;
    const textW = font.widthOfTextAtSize(line, size);
    const left =
      ann.align === "center"
        ? ann.rect.x + (ann.rect.w - textW) / 2
        : ann.align === "right"
          ? ann.rect.x + ann.rect.w - textW
          : ann.rect.x;
    const top = ann.rect.y + i * lineHeight + size * 0.82;
    const { x, y } = toPdfPoint({ x: left, y: top }, pw, ph, rotation);
    page.drawText(sanitize(line), {
      x,
      y,
      size,
      font,
      color: rgb(c.r, c.g, c.b),
      opacity: ann.opacity ?? 1,
      rotate: degrees(rotation),
    });
  });
}

/**
 * Ink is written as ONE smooth SVG path (not a chain of line segments) so
 * markers and pens never show overlapping-cap seams at low opacity.
 */
function drawStroke(page: PDFPage, ann: DrawAnn, pw: number, ph: number, rotation: Rotation) {
  const pts = ann.points.map((p) => toPdfPoint(p, pw, ph, rotation));
  const c = hexToRgb(ann.color);
  if (pts.length === 0) return;
  if (pts.length === 1) {
    page.drawCircle({ x: pts[0].x, y: pts[0].y, size: ann.width / 2, color: rgb(c.r, c.g, c.b), opacity: ann.opacity });
    return;
  }
  const o = pts[0];
  const rel = pts.map((p) => ({ x: p.x - o.x, y: -(p.y - o.y) }));
  let d = `M ${rel[0].x.toFixed(2)} ${rel[0].y.toFixed(2)}`;
  for (let i = 1; i < rel.length - 1; i++) {
    const a = rel[i];
    const b = rel[i + 1];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    d += ` Q ${a.x.toFixed(2)} ${a.y.toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
  }
  const last = rel[rel.length - 1];
  d += ` L ${last.x.toFixed(2)} ${last.y.toFixed(2)}`;
  page.drawSvgPath(d, {
    x: o.x,
    y: o.y,
    borderColor: rgb(c.r, c.g, c.b),
    borderWidth: ann.width,
    borderLineCap: 1 as never, // round caps
    borderOpacity: ann.kind === "highlight" ? 1 : (ann.opacity ?? 1),
    blendMode: ann.kind === "highlight" ? BlendMode.Multiply : undefined,
    rotate: degrees(rotation),
  });
}

/**
 * pdf-lib's standard fonts use WinAnsi: keep Latin-1, map common typographic
 * punctuation, and replace anything else (CJK, currency symbols) with "?".
 */
const WINANSI_MAP: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "\u201C": '"', "\u201D": '"',
  "\u2013": "-", "\u2014": "-", "\u2022": "*", "\u2026": "...", "\u20AC": "EUR",
};
const sanitize = (s: string) =>
  s
    .replace(/[\u2018\u2019\u201C\u201D\u2013\u2014\u2022\u2026\u20AC]/g, (c) => WINANSI_MAP[c] ?? c)
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

/** Invisible text layer built from OCR boxes (render mode 3 / opacity 0). */
async function drawOcrLayer(page: PDFPage, meta: PageMeta, pw: number, ph: number) {
  const font = await page.doc.embedFont(StandardFonts.Helvetica);
  const rot = page.getRotation().angle;
  for (const word of meta.ocr!.words) {
    if (word.conf === -1) continue; // erased words must NOT be searchable
    const clean = sanitize(word.text).trim();
    if (!clean) continue;
    let size = Math.max(1, Math.min(word.h * 0.92, 72));
    const measured = font.widthOfTextAtSize(clean, size);
    if (!isFinite(measured) || measured <= 0) continue;
    if (measured > word.w) size = Math.max(1, (size * word.w) / measured);
    const { x, y } = toPdfPoint({ x: word.x, y: word.y + word.h - size * 0.2 }, pw, ph, meta.rotation);
    try {
      page.drawText(clean, { x, y, size, font, color: rgb(0, 0, 0), opacity: 0, rotate: degrees(rot) });
    } catch {
      /* skip un-encodable glyphs */
    }
  }
}

/** Build a PDF purely from images (scans, photo-only documents, compression). */
export async function buildPdfFromImages(
  images: { dataUrl: string; wPt: number; hPt: number }[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const img of images) {
    const { bytes, mime } = await dataUrlToBytes(img.dataUrl);
    const embedded = mime.includes("png") ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const page = doc.addPage([img.wPt, img.hPt]);
    page.drawImage(embedded, { x: 0, y: 0, width: img.wPt, height: img.hPt });
  }
  doc.setProducer("PDF Scan Lite");
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}

/** Page-count / validity probe that never throws. */
export async function probePdf(bytes: Uint8Array): Promise<{ pages: number; ok: boolean }> {
  try {
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
    return { pages: doc.getPageCount(), ok: true };
  } catch {
    return { pages: 0, ok: false };
  }
}

export { displaySize };
