"use client";

import type { PageMeta } from "@/types";
import { displaySize } from "./utils";
import { pdfStore } from "./pdfStore";
import { loadImage } from "./pdfjs";

/** Source-only raster of a page (no annotations), bounded by `maxSide`. */
export async function renderSourceCanvas(meta: PageMeta, maxSide = 2000): Promise<HTMLCanvasElement> {
  const { w: wPt, h: hPt } = displaySize(meta);
  if (meta.source.kind === "pdf") {
    return pdfStore.render(meta, maxSide);
  }
  const img = await loadImage(meta.source.dataUrl);
  const ratio = hPt / wPt;
  let W = maxSide;
  let H = Math.round(W * ratio);
  if (ratio > 1) {
    H = maxSide;
    W = Math.round(maxSide / ratio);
  }
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate((((meta.rotation % 360) + 360) % 360) * (Math.PI / 180));
  const swap = meta.rotation % 180 !== 0;
  const dw = swap ? H : W;
  const dh = swap ? W : H;
  ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
  return canvas;
}
