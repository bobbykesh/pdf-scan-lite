"use client";

/**
 * OCR engine — tesseract.js inside a dedicated web worker.
 * The worker script, wasm core and (optionally) eng.traineddata are all served
 * from our own /public/vendor directory, so no third-party CDN is needed at
 * runtime and the app keeps working offline once cached by the service worker.
 */
import type { OcrResult, OcrWord, PageMeta } from "@/types";
import { displaySize } from "./utils";
import { TESSERACT_CDN_FALLBACK } from "./config";

interface TessWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

interface TessBlock {
  paragraphs?: {
    lines?: { words?: TessWord[] }[];
  }[];
}

type TesseractWorker = {
  recognize: (image: unknown, opts?: object, output?: object) => Promise<{
    data: {
      text?: string;
      confidence?: number;
      words?: TessWord[];
      blocks?: TessBlock[] | null;
    };
  }>;
  terminate: () => Promise<unknown>;
  setParameters?: (p: Record<string, unknown>) => Promise<unknown>;
};

export interface OcrProgress {
  status: string;
  progress: number;
}

const LANG_PATH = "/vendor/tessdata";
const CORE_PATH = "/vendor/tesseract";

let workerPromise: Promise<TesseractWorker> | null = null;
let currentLang = "eng";

function langConfig(lang: string) {
  return {
    workerPath: "/vendor/tesseract/worker.min.js",
    // When we vendored the traineddata ourselves, point tesseract at it.
    langPath: LANG_PATH,
    corePath: CORE_PATH,
    // force the runtime to request .traineddata (not .gz) from langPath
    gzip: false,
    cacheMethod: "readwrite" as const,
    logger: () => {},
  };
}

async function isVendoredLang(lang: string) {
  try {
    const res = await fetch(`${LANG_PATH}/${lang}.traineddata`, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

async function getWorker(lang: string, onProgress?: (p: OcrProgress) => void) {
  if (workerPromise && currentLang === lang) return workerPromise;
  if (workerPromise) {
    const old = await workerPromise.catch(() => null);
    old?.terminate?.();
    workerPromise = null;
  }
  currentLang = lang;
  workerPromise = (async () => {
    const { createWorker } = await import("tesseract.js");
    const vendored = await isVendoredLang(lang);
    const base = langConfig(lang);
    const opts: Record<string, unknown> = {
      ...base,
      logger: (m: { status?: string; progress?: number }) =>
        onProgress?.({ status: m.status ?? "working", progress: m.progress ?? 0 }),
    };
    if (!vendored) {
      // fall back to the jsDelivr default the library ships with
      delete opts.langPath;
      delete opts.gzip;
      void TESSERACT_CDN_FALLBACK;
    }
    return (await createWorker(lang, 1, opts)) as unknown as TesseractWorker;
  })();
  return workerPromise;
}

export async function disposeOcrWorker() {
  if (!workerPromise) return;
  const w = await workerPromise.catch(() => null);
  await w?.terminate?.().catch(() => {});
  workerPromise = null;
}

export interface OcrInput {
  /** page render, in page-point space (any DPI — bboxes are converted back) */
  canvas: HTMLCanvasElement;
  /** page display size in points */
  pageWidthPt: number;
  pageHeightPt: number;
}

export async function runOcr(
  input: OcrInput,
  lang = "eng",
  onProgress?: (p: OcrProgress) => void
): Promise<OcrResult> {
  const worker = await getWorker(lang, onProgress);
  const target = downscaleForOcr(input.canvas);
  // tesseract.js v6+ only returns `words` when `blocks` output is enabled
  const { data } = await worker.recognize(target, {}, { text: true, blocks: true });

  const rawWords: TessWord[] =
    data.words ??
    (data.blocks ?? []).flatMap((b) =>
      (b.paragraphs ?? []).flatMap((par) => (par.lines ?? []).flatMap((line) => line.words ?? []))
    );

  const sx = input.pageWidthPt / target.width;
  const sy = input.pageHeightPt / target.height;

  const words: OcrWord[] = rawWords
    .filter((w) => w?.text?.trim() && (w.confidence ?? 0) > 35)
    .map((w) => ({
      text: w.text.replace(/\s+/g, " ").trim(),
      x: w.bbox.x0 * sx,
      y: w.bbox.y0 * sy,
      w: Math.max(1, (w.bbox.x1 - w.bbox.x0) * sx),
      h: Math.max(1, (w.bbox.y1 - w.bbox.y0) * sy),
      conf: w.confidence,
    }));

  return {
    words,
    text: data.text?.trim() ?? "",
    confidence: data.confidence ?? 0,
    lang,
    at: Date.now(),
  };
}

/** Tesseract works best around 1000–2500px; big canvases just cost time. */
function downscaleForOcr(canvas: HTMLCanvasElement, maxSide = 2200): HTMLCanvasElement {
  const longest = Math.max(canvas.width, canvas.height);
  if (longest <= maxSide) return canvas;
  const s = maxSide / longest;
  const c = document.createElement("canvas");
  c.width = Math.round(canvas.width * s);
  c.height = Math.round(canvas.height * s);
  const ctx = c.getContext("2d", { alpha: false })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return c;
}

/** Convenience: OCR every page that doesn't have a result yet. */
export async function ocrPages(
  pages: PageMeta[],
  render: (page: PageMeta) => Promise<HTMLCanvasElement>,
  lang: string,
  onProgress?: (pageIndex: number, p: OcrProgress) => void
) {
  const results = new Map<string, OcrResult>();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (page.ocr && page.ocr.lang === lang) {
      results.set(page.id, page.ocr);
      continue;
    }
    const canvas = await render(page);
    const size = displaySize(page);
    const res = await runOcr(
      { canvas, pageWidthPt: size.w, pageHeightPt: size.h },
      lang,
      (p) => onProgress?.(i, p)
    );
    results.set(page.id, res);
  }
  return results;
}
