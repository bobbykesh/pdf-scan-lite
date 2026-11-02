"use client";

/**
 * Page rasteriser — the single source of truth for what a page looks like.
 *
 * The interactive viewport and the PDF exporter both use the same painting
 * functions (`paintBase` + `paintAnnotations`), so what the user sees on the
 * canvas is byte-for-byte what lands in the exported PDF.
 */
import type { Annotation, DrawAnn, OcrWord, PageMeta, TextAnn } from "@/types";
import { displaySize } from "./utils";
import { FONT_CSS } from "./pdfedit";
import { loadImage, blobToDataUrl } from "./pdfjs";
import { pdfStore } from "./pdfStore";

export const ptToPx = (pt: number, dpi: number) => (pt * dpi) / 72;

export function pagePixelSize(meta: PageMeta, dpi: number) {
  const { w, h } = displaySize(meta);
  return { w: Math.max(1, Math.round(ptToPx(w, dpi))), h: Math.max(1, Math.round(ptToPx(h, dpi))) };
}

/** OCR words whose pixels the user replaced (or removed) — erased on export. */
export function isErasedWord(word: OcrWord) {
  return word.conf === -1;
}

/* --------------------------------------------------------------- painting */

export async function paintBase(canvas: HTMLCanvasElement, meta: PageMeta) {
  const { w: wPt, h: hPt } = displaySize(meta);
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  if (meta.source.kind === "pdf") {
    const src = await pdfStore.render(meta, Math.max(W, H));
    ctx.drawImage(src, 0, 0, W, H);
  } else {
    const img = await loadImage(meta.source.dataUrl);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((((meta.rotation % 360) + 360) % 360) * (Math.PI / 180));
    const swap = meta.rotation % 180 !== 0;
    const dw = swap ? H : W;
    const dh = swap ? W : H;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  // erase replaced OCR text right in the pixels
  const erased = meta.ocr?.words?.filter(isErasedWord) ?? [];
  if (erased.length) {
    const k = W / wPt;
    ctx.fillStyle = "#ffffff";
    for (const word of erased) {
      const pad = Math.max(1, word.h * 0.1);
      ctx.fillRect((word.x - pad) * k, (word.y - pad) * k, (word.w + pad * 2) * k, (word.h + pad * 2) * k);
    }
  }
  void hPt;
  return canvas;
}

export async function paintAnnotations(
  ctx: CanvasRenderingContext2D,
  annotations: Annotation[],
  k: number,
  excludeIds?: Set<string>
) {
  for (const ann of annotations) {
    if (excludeIds?.has(ann.id)) continue;
    switch (ann.type) {
      case "redact":
        ctx.fillStyle = ann.color || "#ffffff";
        ctx.fillRect(ann.rect.x * k, ann.rect.y * k, ann.rect.w * k, ann.rect.h * k);
        break;
      case "draw":
        drawStroke(ctx, ann, k);
        break;
      case "image": {
        try {
          const img = await loadImage(ann.dataUrl);
          ctx.save();
          ctx.globalAlpha = ann.opacity ?? 1;
          ctx.drawImage(img, ann.rect.x * k, ann.rect.y * k, ann.rect.w * k, ann.rect.h * k);
          ctx.restore();
        } catch {
          /* broken image data — skip */
        }
        break;
      }
      case "text":
        drawText(ctx, ann, k);
        break;
    }
  }
}

export function drawStroke(ctx: CanvasRenderingContext2D, ann: DrawAnn, k: number) {
  if (!ann.points.length) return;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.globalAlpha = ann.opacity ?? 1;
  ctx.globalCompositeOperation = ann.kind === "highlight" ? "multiply" : "source-over";
  ctx.strokeStyle = ann.color;
  ctx.fillStyle = ann.color;
  const w = Math.max(0.5, ann.width * k);
  if (ann.points.length === 1) {
    const p = ann.points[0];
    ctx.beginPath();
    ctx.arc(p.x * k, p.y * k, w / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(ann.points[0].x * k, ann.points[0].y * k);
    for (let i = 1; i < ann.points.length - 1; i++) {
      const a = ann.points[i];
      const b = ann.points[i + 1];
      ctx.quadraticCurveTo(a.x * k, a.y * k, ((a.x + b.x) / 2) * k, ((a.y + b.y) / 2) * k);
    }
    const last = ann.points[ann.points.length - 1];
    ctx.lineTo(last.x * k, last.y * k);
    ctx.stroke();
  }
  ctx.restore();
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (!raw) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of raw.split(/(\s+)/)) {
      const test = line + word;
      if (ctx.measureText(test).width > maxWidth && line.trim()) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line = test;
    }
    out.push(line.trimEnd());
  }
  return out;
}

export function drawText(ctx: CanvasRenderingContext2D, ann: TextAnn, k: number) {
  const size = Math.max(1, ann.fontSize) * k;
  ctx.save();
  ctx.globalAlpha = ann.opacity ?? 1;
  const weight = ann.fontKey.includes("bold") ? "700" : "400";
  ctx.font = `${weight} ${size}px ${FONT_CSS[ann.fontKey] ?? FONT_CSS.helvetica}`;
  ctx.fillStyle = ann.color;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = ann.align === "center" ? "center" : ann.align === "right" ? "right" : "left";
  const x =
    ann.align === "center"
      ? (ann.rect.x + ann.rect.w / 2) * k
      : ann.align === "right"
        ? (ann.rect.x + ann.rect.w) * k
        : ann.rect.x * k;
  const lineH = size * (ann.lineHeight || 1.25);
  const lines = wrapLines(ctx, ann.text, ann.rect.w * k);
  lines.forEach((line, i) => {
    if (!line) return;
    ctx.fillText(line, x, ann.rect.y * k + i * lineH + size * 0.82);
  });
  ctx.restore();
}

/* ----------------------------------------------------------- full renders */

export interface RenderPageOptions {
  dpi: number;
  annotations: Annotation[];
  excludeIds?: string[];
}

export async function renderFlattenedPage(meta: PageMeta, opts: RenderPageOptions) {
  const { w, h } = pagePixelSize(meta, opts.dpi);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  await paintBase(canvas, meta);
  const ctx = canvas.getContext("2d")!;
  const k = w / displaySize(meta).w;
  await paintAnnotations(ctx, opts.annotations, k, new Set(opts.excludeIds ?? []));
  return { canvas, width: w, height: h, k };
}

/** Flattened image of a page (export / compression / PDF→image). */
export async function pageToExportImage(
  meta: PageMeta,
  opts: RenderPageOptions & { quality: number; format: "jpeg" | "png" }
) {
  const { canvas, width, height } = await renderFlattenedPage(meta, opts);
  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob(
      (b) => (b ? res(b) : rej(new Error("encode failed"))),
      opts.format === "png" ? "image/png" : "image/jpeg",
      opts.format === "png" ? undefined : opts.quality
    )
  );
  return { blob, dataUrl: await blobToDataUrl(blob), width, height };
}
