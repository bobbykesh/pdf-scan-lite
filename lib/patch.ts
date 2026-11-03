/**
 * Painting edits into the page, the way a scanned page is actually repaired:
 * cover the old area with the page's own paper, then draw the new content to
 * match the size, weight and position of what was there.
 *
 * The previous approach filled a hard white rectangle and stamped Helvetica in
 * the corner of it. On a phone scan — grey paper, soft edges — that reads as a
 * sticker. Everything here is measured from the page so it does not.
 */

import type { Rect } from "@/types";
import { inkAround, paperAround, type RGB } from "./ink";

/** The soft, unpainted margin around a patch, in points. */
const FEATHER_PT = 1.2;

export interface PaintOpts {
  /** page-px per point */
  k: number;
  /** colour of the paper the patch sits on */
  paper: RGB;
  /** colour the surrounding text was printed in */
  ink: RGB;
}

/**
 * Cover an area with paper.
 *
 * Two things make the difference between a patch and an obvious box:
 *   - the colour is the page's own paper, not white;
 *   - the edge is feathered over ~1pt, so the seam does not survive as a hard
 *     line when the page came off a camera. A feathered edge also lets a
 *     gradient of lighting across the box blend rather than clash.
 */
export function coverWithPaper(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  opts: PaintOpts,
  featherPt = FEATHER_PT
) {
  const { k, paper } = opts;
  const x = rect.x * k;
  const y = rect.y * k;
  const w = Math.max(1, rect.w * k);
  const h = Math.max(1, rect.h * k);
  const f = Math.max(0.6, featherPt * k);

  const base = `rgb(${Math.round(paper.r)}, ${Math.round(paper.g)}, ${Math.round(paper.b)})`;

  ctx.save();

  // Solid core: everything but the last `f` px on each side.
  ctx.fillStyle = base;
  ctx.fillRect(x + f, y + f, Math.max(0, w - f * 2), Math.max(0, h - f * 2));

  // Four feathered bands, each a gradient from paper → transparent, drawn
  // outward from the core. Cheap, and it hides the seam on a textured page.
  const clear = `rgba(${Math.round(paper.r)}, ${Math.round(paper.g)}, ${Math.round(paper.b)}, 0)`;

  if (f > 0.4) {
    // top
    let g = ctx.createLinearGradient(0, y, 0, y + f);
    g.addColorStop(0, clear);
    g.addColorStop(1, base);
    ctx.fillStyle = g;
    ctx.fillRect(x + f, y, Math.max(0, w - f * 2), f);
    // bottom
    g = ctx.createLinearGradient(0, y + h - f, 0, y + h);
    g.addColorStop(0, base);
    g.addColorStop(1, clear);
    ctx.fillStyle = g;
    ctx.fillRect(x + f, y + h - f, Math.max(0, w - f * 2), f);
    // left
    g = ctx.createLinearGradient(x, 0, x + f, 0);
    g.addColorStop(0, clear);
    g.addColorStop(1, base);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, f, h);
    // right
    g = ctx.createLinearGradient(x + w - f, 0, x + w, 0);
    g.addColorStop(0, base);
    g.addColorStop(1, clear);
    ctx.fillStyle = g;
    ctx.fillRect(x + w - f, y, f, h);
  } else {
    ctx.fillStyle = base;
    ctx.fillRect(x, y, w, h);
  }

  ctx.restore();
}

/**
 * Cover a whole word box, including its overshoot.
 *
 * The box OCR reports is generous — ascender and descender space even for a
 * word with none, and a little slack either side. Covering all of it leaves a
 * clean band of paper above and below the old glyphs, which is itself a tell.
 * `inset` tightens it to the glyphs actually there.
 */
export function coverWord(
  ctx: CanvasRenderingContext2D,
  word: { x: number; y: number; w: number; h: number },
  inset: { left: number; right: number; top: number; bottom: number },
  opts: PaintOpts
) {
  /*
   * Cover the whole measured box, not just the tight glyph bounds.
   *
   * Tightening to the glyphs looked tidier in theory and was wrong in practice:
   * glyph edges are anti-aliased and fade over a pixel or two, and the ink
   * threshold that finds the glyphs deliberately ignores those faint pixels. The
   * result was a halo of the old word peeking out above and below the patch.
   * With the paper colour sampled from the page, covering the full box is
   * invisible — the extra area is all paper anyway.
   */
  const pad = Math.max(0.5, word.h * 0.12);
  const rect: Rect = {
    x: word.x - pad,
    y: word.y - pad,
    w: word.w + pad * 2,
    h: word.h + pad * 2,
  };
  void inset;
  coverWithPaper(ctx, rect, opts);
  return rect;
}

/**
 * Draw replacement text so it sits on the page like the original.
 *
 * Fit is the whole trick: the replacement is measured and shrunk until it fits
 * the width of the word it replaces, so it neither spills past the box nor
 * leaves a gap. The baseline is placed from the glyph bottom rather than the
 * box, because the box includes descender space this word may not use.
 */
export function drawFittedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  box: Rect,
  opts: PaintOpts & {
    fontSizePt: number;
    fontCss: string;
    weight?: string;
    align?: "left" | "center" | "right";
    lineHeight?: number;
    /** bottom of the original glyphs, in points — the baseline to sit on */
    baselinePt?: number;
    /** cap height of the original glyphs, in points — the size to match */
    glyphHPt?: number;
  }
): number {
  const { k, ink } = opts;
  const value = text.replace(/\s+$/g, "");
  if (!value) return opts.fontSizePt;

  /*
   * Size from the original glyphs, not from the line box.
   *
   * The OCR box is the line height: it includes ascender and descender space.
   * Using it directly as a font size drew replacement text a good deal smaller
   * than the text beside it (cap height is roughly 0.7em). When the caller can
   * measure the real glyph height, do that; otherwise fall back to the box.
   */
  const glyphH = opts.glyphHPt && opts.glyphHPt > 0 ? opts.glyphHPt : opts.fontSizePt * 0.98;
  let sizePt = Math.max(2, glyphH / 0.72);
  const maxW = box.w * k;
  const weight = opts.weight ?? "400";
  const font = (s: number) => `${weight} ${s * k}px ${opts.fontCss}`;

  ctx.save();
  ctx.font = font(sizePt);
  // Shrink to fit rather than overflow, down to a floor that stays legible.
  const floor = Math.max(2, sizePt * 0.45);
  while (ctx.measureText(value).width > maxW && sizePt > floor) {
    sizePt *= 0.97;
    ctx.font = font(sizePt);
  }

  const measured = ctx.measureText(value).width;
  const align = opts.align ?? "left";
  let x = box.x * k;
  if (align === "center") x = box.x * k + (maxW - measured) / 2;
  else if (align === "right") x = box.x * k + (maxW - measured);

  // Baseline: the bottom of the original glyphs when known, so the replacement
  // sits on the same line as the words either side of it.
  const baseline =
    opts.baselinePt !== undefined ? opts.baselinePt * k : box.y * k + box.h * k * 0.8;

  ctx.fillStyle = `rgb(${Math.round(ink.r)}, ${Math.round(ink.g)}, ${Math.round(ink.b)})`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(value, x, baseline);
  ctx.restore();

  return sizePt;
}

/** Convenience: the CSS family for a stored font key. */
export const FONT_CSS: Record<string, string> = {
  helvetica: "Helvetica, Arial, sans-serif",
  "helvetica-bold": "Helvetica, Arial, sans-serif",
  times: '"Times New Roman", Times, serif',
  "times-bold": '"Times New Roman", Times, serif',
  courier: '"Courier New", Courier, monospace',
};

export const fontWeight = (key: string) => (key.includes("bold") ? "700" : "400");
