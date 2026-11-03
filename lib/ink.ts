/**
 * Ink sampling: work out what a patch of page *looks like* so edits can be
 * painted into the pixels instead of pasted on top of them.
 *
 * A phone scan is not white paper. It is grey-ish paper, unevenly lit, often
 * with a shadow down one side, sometimes with ruled lines or a tinted
 * background. An edit that assumes pure white and pure black is visible
 * immediately: a white box floating on a grey page with text that does not
 * match anything around it.
 *
 * Everything here is measured from the page itself:
 *
 *   paper  — the colour of the area *around* the thing being replaced, taken as
 *            a median so a stray line or shadow does not skew it;
 *   ink    — the colour of the surrounding text, taken as a dark percentile of
 *            the words nearby, so replacement text is the same weight as the
 *            text it replaces;
 *   inset  — how far the measured word box overshoots the visible glyphs, so the
 *            patch is no bigger than it needs to be.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export const rgbCss = (c: RGB) =>
  `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;

const luma = (c: RGB) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

function sample(canvas: HTMLCanvasElement, x: number, y: number): RGB | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const px = Math.max(0, Math.min(canvas.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(canvas.height - 1, Math.round(y)));
  const d = ctx.getImageData(px, py, 1, 1).data;
  return { r: d[0], g: d[1], b: d[2] };
}

/**
 * Median RGB of a set of samples.
 *
 * Median rather than mean on purpose: one dark pixel of ruled line or one
 * bright speck of dust should not move the answer.
 */
function median(samples: RGB[]): RGB | null {
  if (!samples.length) return null;
  const mid = (arr: number[]) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  return {
    r: mid(samples.map((s) => s.r)),
    g: mid(samples.map((s) => s.g)),
    b: mid(samples.map((s) => s.b)),
  };
}

/**
 * The paper colour around a rectangle.
 *
 * Samples a ring just *outside* the box — that band is almost entirely paper,
 * because a word's box is drawn tight around the glyphs. Sampling inside the
 * box would average paper with ink and give a grey that matches nothing.
 *
 * When the box sits hard against the edge of the page the ring is clipped, so
 * whatever samples remain are still taken from inside the page.
 */
export function paperAround(
  canvas: HTMLCanvasElement,
  rect: { x: number; y: number; w: number; h: number },
  k: number
): RGB {
  const pad = Math.max(2, rect.h * 0.55) * k;
  const x0 = rect.x * k - pad;
  const y0 = rect.y * k - pad;
  const x1 = (rect.x + rect.w) * k + pad;
  const y1 = (rect.y + rect.h) * k + pad;

  const samples: RGB[] = [];
  const stepX = Math.max(1, (x1 - x0) / 14);
  const stepY = Math.max(1, (y1 - y0) / 8);

  // top and bottom bands
  for (let x = x0; x <= x1; x += stepX) {
    const a = sample(canvas, x, y0 + pad * 0.25);
    const b = sample(canvas, x, y1 - pad * 0.25);
    if (a) samples.push(a);
    if (b) samples.push(b);
  }
  // left and right bands
  for (let y = y0; y <= y1; y += stepY) {
    const a = sample(canvas, x0 + pad * 0.25, y);
    const b = sample(canvas, x1 - pad * 0.25, y);
    if (a) samples.push(a);
    if (b) samples.push(b);
  }

  const m = median(samples);
  if (!m) return { r: 255, g: 255, b: 255 };

  /*
   * Guard against the ring landing on something that is not paper — a photo, a
   * solid header bar, a signature. Paper is light; if the median is dark the
   * ring has picked up a block of content, and painting a patch from it would
   * smear content across the edit. Fall back to the lightest samples, and to
   * white if even those are not paper-like.
   */
  if (luma(m) < 150) {
    const light = samples.filter((s) => luma(s) >= 150);
    const lm = median(light);
    if (lm) return lm;
    return { r: 255, g: 255, b: 255 };
  }
  return m;
}

/**
 * The ink colour of nearby text.
 *
 * Uses the darkest tenth of the sampled ring: the glyph strokes of the
 * surrounding words. Returning near-black for a faded scan is what makes
 * replacement text look pasted on, so this deliberately follows the page.
 */
export function inkAround(
  canvas: HTMLCanvasElement,
  rect: { x: number; y: number; w: number; h: number },
  k: number,
  fallback: RGB = { r: 17, g: 17, b: 17 }
): RGB {
  const pad = Math.max(3, rect.h * 0.9) * k;
  const x0 = rect.x * k - pad;
  const y0 = rect.y * k - pad;
  const x1 = (rect.x + rect.w) * k + pad;
  const y1 = (rect.y + rect.h) * k + pad;
  const stepX = Math.max(1, (x1 - x0) / 10);
  const stepY = Math.max(1, (y1 - y0) / 6);

  const samples: RGB[] = [];
  for (let y = y0; y <= y1; y += stepY) {
    for (let x = x0; x <= x1; x += stepX) {
      const s = sample(canvas, x, y);
      if (s) samples.push(s);
    }
  }
  const paper = paperAround(canvas, rect, k);
  const paperLuma = luma(paper);
  // Only call something "ink" if it is genuinely darker than its paper.
  const dark = samples.filter((s) => paperLuma - luma(s) > 45).sort((a, b) => luma(a) - luma(b));
  if (dark.length < 4) return fallback;
  const core = dark.slice(0, Math.max(1, Math.ceil(dark.length * 0.1)));
  return median(core) ?? fallback;
}

/**
 * How far a measured word box overshoots the visible glyphs, in page points.
 *
 * OCR boxes are generous: they include ascender and descender space even for
 * lowercase words, and often a little padding on each side. Patching the whole
 * box leaves a visible strip of clean paper above and below the old word. This
 * measures the actual dark pixels inside the box and returns the tight inset.
 */
export function glyphInset(
  canvas: HTMLCanvasElement,
  rect: { x: number; y: number; w: number; h: number },
  k: number
): { left: number; right: number; top: number; bottom: number } {
  const none = { left: 0, right: 0, top: 0, bottom: 0 };
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return none;

  const x = Math.max(0, Math.round(rect.x * k));
  const y = Math.max(0, Math.round(rect.y * k));
  const w = Math.min(canvas.width - x, Math.round(rect.w * k));
  const h = Math.min(canvas.height - y, Math.round(rect.h * k));
  if (w < 3 || h < 3) return none;

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(x, y, w, h).data;
  } catch {
    return none;
  }

  const paper = paperAround(canvas, rect, k);
  const paperLuma = luma(paper);
  const threshold = paperLuma - 40;
  const isInk = (px: number, py: number) => {
    const i = (py * w + px) * 4;
    return luma({ r: data[i], g: data[i + 1], b: data[i + 2] }) < threshold;
  };

  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      if (!isInk(px, py)) continue;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  // Nothing dark enough to be text (a blank cell, a mis-detected box).
  if (maxX < 0) return none;

  // Ignore a single speck: a couple of stray pixels are noise, not glyphs.
  if (maxX - minX < 2 || maxY - minY < 2) return none;

  return {
    left: minX / k,
    right: (w - 1 - maxX) / k,
    top: minY / k,
    bottom: (h - 1 - maxY) / k,
  };
}

/** Paper colour for a whole page, used when there is no local rect to sample. */
export function pagePaper(canvas: HTMLCanvasElement): RGB {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { r: 255, g: 255, b: 255 };
  const samples: RGB[] = [];
  const stepX = Math.max(1, Math.floor(canvas.width / 24));
  const stepY = Math.max(1, Math.floor(canvas.height / 24));
  for (let y = 0; y < canvas.height; y += stepY) {
    for (let x = 0; x < canvas.width; x += stepX) {
      const s = sample(canvas, x, y);
      if (s && luma(s) > 120) samples.push(s);
    }
  }
  return median(samples) ?? { r: 255, g: 255, b: 255 };
}

/**
 * The extent of the actual glyphs inside a box, in page points.
 *
 * `h` is the cap-to-descender height the text really occupies and `bottom` is
 * the bottom of the glyphs (close to the baseline for text without descenders)
 * — both needed to draw replacement text at the size and position of the text
 * it replaces. Returns null when the box holds nothing dark enough to measure.
 */
export function glyphMetrics(
  canvas: HTMLCanvasElement,
  rect: { x: number; y: number; w: number; h: number },
  k: number
): { h: number; bottom: number; left: number; right: number } | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const x = Math.max(0, Math.round(rect.x * k));
  const y = Math.max(0, Math.round(rect.y * k));
  const w = Math.min(canvas.width - x, Math.round(rect.w * k));
  const h = Math.min(canvas.height - y, Math.round(rect.h * k));
  if (w < 2 || h < 2) return null;

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(x, y, w, h).data;
  } catch {
    return null;
  }

  const paperLuma = luma(paperAround(canvas, rect, k));
  const threshold = paperLuma - 45;

  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4;
      const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (l >= threshold) continue;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  if (maxX < 0 || maxY < 0 || maxX - minX < 2 || maxY - minY < 2) return null;

  return {
    h: (maxY - minY + 1) / k,
    bottom: (y + maxY + 1) / k,
    left: (x + minX) / k,
    right: (x + maxX) / k,
  };
}
