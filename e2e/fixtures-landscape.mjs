#!/usr/bin/env node
/**
 * Landscape fixture: a portrait A4 sheet lying SIDEWAYS on a dark desk, shot
 * in landscape — i.e. the sheet's long edge runs across the frame.
 *
 * This is the case the user reported as "cropping looks fine but the page comes
 * out wrong after Add page".
 *
 *   e2e/landscape-doc.png  – for the gallery / image-import path
 *   e2e/landscape-doc.y4m  – for Chromium's fake camera
 *
 * Usage: node e2e/fixtures-landscape.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const W = 1280;
const H = 960;

const px = new Uint8Array(W * H * 3);
const put = (x, y, [r, g, b]) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
};
const fillRect = (x0, y0, x1, y1, c) => {
  for (let y = Math.round(y0); y < Math.round(y1); y++)
    for (let x = Math.round(x0); x < Math.round(x1); x++) put(x, y, c);
};
const DESK = [56, 50, 44];
const SHEET = [246, 243, 236];
const INK = [24, 26, 32];

fillRect(0, 0, W, H, DESK);

/**
 * The sheet: A4 aspect (1 : 1.414) turned landscape → 1.414 : 1.
 * Slight hand-held tilt, corners nudged independently.
 */
const quad = [
  [140, 210],
  [1150, 150],
  [1170, 800],
  [120, 830],
];
const TOP = quad[0];
const TOPR = quad[1];
const BOTR = quad[2];
const BOT = quad[3];

for (let v = 0; v <= 1200; v++) {
  const t = v / 1200;
  const a = [TOP[0] + (TOPR[0] - TOP[0]) * t, TOP[1] + (TOPR[1] - TOP[1]) * t];
  const b = [BOT[0] + (BOTR[0] - BOT[0]) * t, BOT[1] + (BOTR[1] - BOT[1]) * t];
  for (let u = 0; u <= 1200; u++) {
    const s = u / 1200;
    const x = a[0] + (b[0] - a[0]) * s;
    const y = a[1] + (b[1] - a[1]) * s;
    const shade = 1 - 0.05 * s - 0.05 * t;
    put(Math.round(x), Math.round(y), SHEET.map((c) => Math.round(c * shade)));
  }
}

/** map sheet-space (u,v in 0..1) to frame pixels, so ink follows the tilt */
const at = (u, v) => {
  const ta = [TOP[0] + (TOPR[0] - TOP[0]) * u, TOP[1] + (TOPR[1] - TOP[1]) * u];
  const tb = [BOT[0] + (BOTR[0] - BOT[0]) * u, BOT[1] + (BOTR[1] - BOT[1]) * u];
  return [ta[0] + (tb[0] - ta[0]) * v, ta[1] + (tb[1] - ta[1]) * v];
};

/** a thick line in sheet space (quads made of many short strokes) */
const sheetLine = (u0, v0, u1, v1, width = 0.012) => {
  const steps = Math.ceil(Math.hypot(u1 - u0, v1 - v0) * 600);
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    const [x, y] = at(u0 + (u1 - u0) * t, v0 + (v1 - v0) * t);
    const r = (width * 660) / 2;
    for (let dy = -r; dy <= r; dy += 0.5) {
      for (let dx = -r; dx <= r; dx += 0.5) {
        if (dx * dx + dy * dy <= r * r) put(Math.round(x + dx), Math.round(y + dy), INK);
      }
    }
  }
};

/* A big "WIDE" wordmark, drawn as strokes so it stays readable after warp */
const glyph = (u, v, w, h, strokes) => {
  for (const [a, b, c, d] of strokes) sheetLine(u + a * w, v + b * h, u + c * w, v + d * h, 0.008);
};
// W
glyph(0.10, 0.16, 0.10, 0.18, [
  [0, 0, 0.25, 1],
  [0.25, 1, 0.5, 0.35],
  [0.5, 0.35, 0.75, 1],
  [0.75, 1, 1, 0],
]);
// I
glyph(0.235, 0.16, 0.01, 0.18, [[0.5, 0, 0.5, 1]]);
// D
glyph(0.26, 0.16, 0.10, 0.18, [
  [0, 0, 0, 1],
  [0, 0, 0.6, 0],
  [0.6, 0, 1, 0.3],
  [1, 0.3, 1, 0.7],
  [1, 0.7, 0.6, 1],
  [0.6, 1, 0, 1],
]);
// E
glyph(0.39, 0.16, 0.09, 0.18, [
  [0, 0, 0, 1],
  [0, 0, 1, 0],
  [0, 0.5, 0.8, 0.5],
  [0, 1, 1, 1],
]);

/* ruled lines across the sheet, like body text */
for (let i = 0; i < 11; i++) {
  const v = 0.44 + i * 0.045;
  sheetLine(0.10, v, 0.90 - (i % 3) * 0.08, v, 0.010);
}

/* a boxed footer, so orientation is obvious */
sheetLine(0.10, 0.9, 0.55, 0.9, 0.010);
sheetLine(0.10, 0.95, 0.55, 0.95, 0.010);
sheetLine(0.10, 0.9, 0.10, 0.95, 0.010);
sheetLine(0.55, 0.9, 0.55, 0.95, 0.010);

/* -------------------------------------------------------------------- PNG */
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc(H * (W * 3 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 6 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(join(here, "landscape-doc.png"), png);
console.log("wrote e2e/landscape-doc.png", `${W}x${H}`, `${(png.length / 1024).toFixed(0)} KB`);

/* -------------------------------------------------------------------- Y4M */
const yuv = Buffer.alloc(W * H + 2 * (W / 2) * (H / 2));
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    yuv[y * W + x] = Math.max(0, Math.min(255, Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2])));
  }
}
const uOff = W * H;
const vOff = uOff + (W / 2) * (H / 2);
for (let y = 0; y < H; y += 2) {
  for (let x = 0; x < W; x += 2) {
    const i = (y * W + x) * 3;
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const idx = (y / 2) * (W / 2) + x / 2;
    yuv[uOff + idx] = Math.max(0, Math.min(255, Math.round(-0.169 * r - 0.331 * g + 0.5 * b + 128)));
    yuv[vOff + idx] = Math.max(0, Math.min(255, Math.round(0.5 * r - 0.419 * g - 0.081 * b + 128)));
  }
}
const frames = Buffer.concat([
  Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`),
  Buffer.from("FRAME\n"),
  yuv,
  Buffer.from("FRAME\n"),
  yuv,
]);
writeFileSync(join(here, "landscape-doc.y4m"), frames);
console.log("wrote e2e/landscape-doc.y4m", `${(frames.length / 1024).toFixed(0)} KB`);
