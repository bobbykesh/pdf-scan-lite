import type { OcrResult, PageMeta, Rotation } from "@/types";

export const uid = (prefix = "id") =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const round = (v: number, p = 2) => Math.round(v * 10 ** p) / 10 ** p;

/** #rrggbb -> {r,g,b} in 0..1 (pdf-lib colour space) */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h || "000000", 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export function rgbToHex(r: number, g: number, b: number) {
  const to = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** rotate a point inside a w×h box by `rot` degrees clockwise */
export function rotatePoint(p: { x: number; y: number }, w: number, h: number, rot: Rotation) {
  switch (rot) {
    case 90:
      return { x: h - p.y, y: p.x };
    case 180:
      return { x: w - p.x, y: h - p.y };
    case 270:
      return { x: p.y, y: w - p.x };
    default:
      return { ...p };
  }
}

/** rotate a rect inside a w×h box by `rot` degrees clockwise, keeping it axis aligned */
export function rotateRect(r: { x: number; y: number; w: number; h: number }, w: number, h: number, rot: Rotation) {
  if (rot === 0) return { ...r };
  if (rot === 180) return { x: w - r.x - r.w, y: h - r.y - r.h, w: r.w, h: r.h };
  // 90 / 270 swap the axes
  if (rot === 90) return { x: h - r.y - r.h, y: r.x, w: r.h, h: r.w };
  return { x: r.y, y: w - r.x - r.w, w: r.h, h: r.w };
}

/** rotate an OCR word list so it still lines up with the rotated canvas */
export function rotateOcr(ocr: OcrResult, w: number, h: number, rot: Rotation): OcrResult {
  if (rot === 0) return ocr;
  return {
    ...ocr,
    words: ocr.words.map((word) => {
      const r = rotateRect({ x: word.x, y: word.y, w: word.w, h: word.h }, w, h, rot);
      return { ...word, x: r.x, y: r.y, w: r.w, h: r.h };
    }),
  };
}

export const displaySize = (p: PageMeta) =>
  p.rotation % 180 === 0 ? { w: p.wPt, h: p.hPt } : { w: p.hPt, h: p.wPt };

/** Approximate decoded size of a data: URL (base64 overhead removed). */
export function dataUrlBytes(dataUrl: string) {
  const i = dataUrl.indexOf(",");
  if (i < 0) return 0;
  const b64 = dataUrl.slice(i + 1);
  return Math.round((b64.length * 3) / 4);
}

export function formatBytes(n: number) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** A4 (595.28 × 841.89) fit, full bleed, keeping the aspect ratio of the source. */
export function fitA4(wPx: number, hPx: number) {
  const A_W = 595.28;
  const A_H = 841.89;
  const scale = Math.max(A_W / wPx, A_H / hPx);
  return { wPt: round(wPx * scale), hPt: round(hPx * scale) };
}
