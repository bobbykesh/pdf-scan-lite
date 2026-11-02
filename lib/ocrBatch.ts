"use client";

import type { OcrResult, PageMeta } from "@/types";
import { displaySize } from "./utils";
import { renderSourceCanvas } from "./render";
import { runOcr } from "./ocr";

export async function runOcrBatch(
  pages: PageMeta[],
  hooks: {
    lang?: string;
    onProgress?: (done: number, total: number, status: string) => void;
    onPageDone?: (pageId: string, result: OcrResult) => void;
    onError?: (pageId: string, err: unknown) => void;
  }
) {
  const lang = hooks.lang ?? "eng";
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    try {
      const canvas = await renderSourceCanvas(page, 1800);
      const { w, h } = displaySize(page);
      const result = await runOcr({ canvas, pageWidthPt: w, pageHeightPt: h }, lang, (p) => {
        hooks.onProgress?.(i, pages.length, `${p.status} ${Math.round(p.progress * 100)}%`);
      });
      hooks.onPageDone?.(page.id, result);
    } catch (err) {
      console.error("OCR failed for page", i + 1, err);
      hooks.onError?.(page.id, err);
      throw err;
    }
  }
}
