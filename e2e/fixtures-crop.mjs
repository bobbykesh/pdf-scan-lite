#!/usr/bin/env node
/**
 * Hard auto-crop fixtures, modelled on the photos the user reported.
 *
 *   crop-floor.png      – glossy card on a BRIGHT tiled floor, angled, with the
 *                         floor running off every edge (the case that made the
 *                         detector crop half the room)
 *   crop-dark.png       – white A4 sheet on a DARK desk (the classic case)
 *   crop-darkcard.png   – a DARK ID card on a light surface (inverted contrast)
 *
 * Each ships a sidecar `.json` with the true corner positions so the detector
 * can be scored numerically instead of by eye.
 *
 * Usage: node e2e/fixtures-crop.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ raster */
function makeImage(W, H) {
  const px = new Uint8Array(W * H * 3);
  return {
    W,
    H,
    px,
    put(x, y, [r, g, b]) {
      x = Math.round(x);
      y = Math.round(y);
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = (y * W + x) * 3;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
    },
    fill(x0, y0, x1, y1, c) {
      for (let y = Math.round(y0); y < Math.round(y1); y++)
        for (let x = Math.round(x0); x < Math.round(x1); x++) this.put(x, y, c);
    },
    /** deterministic value noise, so tests are reproducible */
    noise(amount, seed = 1) {
      let s = seed >>> 0;
      const rnd = () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
      };
      for (let i = 0; i < px.length; i += 3) {
        const n = (rnd() - 0.5) * amount;
        px[i] = Math.max(0, Math.min(255, px[i] + n));
        px[i + 1] = Math.max(0, Math.min(255, px[i + 1] + n));
        px[i + 2] = Math.max(0, Math.min(255, px[i + 2] + n));
      }
    },
  };
}

/** fill the quad of a sheet, plus ink strokes inside it (sheet-space 0..1) */
function drawSheet(img, quad, sheetColor, inkColor, opts = {}) {
  const { lines = 10, title = true, gloss = 0 } = opts;
  const [TL, TR, BR, BL] = quad;
  const at = (u, v) => {
    const tx = TL[0] + (TR[0] - TL[0]) * u;
    const ty = TL[1] + (TR[1] - TL[1]) * u;
    const bx = BL[0] + (BR[0] - BL[0]) * u;
    const by = BL[1] + (BR[1] - BL[1]) * u;
    return [tx + (bx - tx) * v, ty + (by - ty) * v];
  };
  // solid fill with a soft shading gradient so filters have work to do
  const N = 2400; // dense enough that no pixel gaps appear in the sheet fill
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const u = i / N;
      const v = j / N;
      const [x, y] = at(u, v);
      const shade = 1 - 0.05 * v - 0.04 * u;
      const glint = gloss ? gloss * Math.max(0, 1 - Math.hypot(u - 0.62, v - 0.28) * 3.2) : 0;
      img.put(
        x,
        y,
        sheetColor.map((c) => Math.min(255, Math.round(c * shade + glint * 90)))
      );
    }
  }
  // ink: title bar + ruled lines + a photo block
  const stroke = (u0, v0, u1, v1, widthPx) => {
    const steps = Math.max(2, Math.ceil(Math.hypot(u1 - u0, v1 - v0) * N));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const [x, y] = at(u0 + (u1 - u0) * t, v0 + (v1 - v0) * t);
      const r = widthPx / 2;
      for (let dy = -r; dy <= r; dy += 0.4)
        for (let dx = -r; dx <= r; dx += 0.4)
          if (dx * dx + dy * dy <= r * r) img.put(x + dx, y + dy, inkColor);
    }
  };
  if (title) stroke(0.08, 0.12, 0.62, 0.12, 7);
  for (let i = 0; i < lines; i++) {
    const v = 0.26 + i * (0.6 / lines);
    const right = 0.9 - (i % 3) * 0.07;
    stroke(0.08, v, right, v, 4);
  }
  // portrait box, so orientation is unmistakable
  stroke(0.8, 0.3, 0.9, 0.3, 3);
  stroke(0.8, 0.3, 0.8, 0.5, 3);
  stroke(0.9, 0.3, 0.9, 0.5, 3);
  stroke(0.8, 0.5, 0.9, 0.5, 3);
}

function writePng(name, img) {
  const { W, H, px } = img;
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
  writeFileSync(join(here, name), png);
  console.log("wrote", name, `${W}x${H}`, `${(png.length / 1024).toFixed(0)} KB`);
}

/* ----------------------------------------------------- 1. bright floor, card */
{
  const W = 1280;
  const H = 960;
  const img = makeImage(W, H);
  // tiled floor: pale warm tiles with grout lines, running off every edge
  img.fill(0, 0, W, H, [196, 176, 150]);
  for (let y = 0; y < H; y += 120) for (let x = 0; x < W; x += 120) img.fill(x, y, x + 118, y + 118, [206, 187, 161]);
  for (let y = 0; y < H; y += 120) img.fill(0, y, W, y + 3, [150, 130, 108]);
  for (let x = 0; x < W; x += 120) img.fill(x, 0, x + 3, H, [150, 130, 108]);
  // a dark object top-right (a bag), like the photo
  img.fill(880, 60, 1240, 190, [88, 92, 104]);
  // the card: landscape, small, glossy, tilted
  // ID-1 card at a realistic angle: 1.6 : 1 (a credit-card / national-ID shape)
  const quad = [
    [430, 560],
    [880, 588],
    [866, 869],
    [420, 842],
  ];
  drawSheet(img, quad, [238, 236, 228], [40, 40, 48], { lines: 8, gloss: 0.85 });
  img.noise(9, 7);
  writePng("crop-floor.png", img);
  writeFileSync(join(here, "crop-floor.json"), JSON.stringify({ W, H, quad }));
}

/* ----------------------------------------------- 2. dark desk, white sheet */
{
  const W = 1280;
  const H = 960;
  const img = makeImage(W, H);
  img.fill(0, 0, W, H, [58, 52, 46]);
  const quad = [
    [250, 120],
    [1040, 160],
    [1000, 850],
    [210, 810],
  ];
  drawSheet(img, quad, [244, 242, 236], [28, 30, 36], { lines: 12 });
  img.noise(10, 3);
  writePng("crop-dark.png", img);
  writeFileSync(join(here, "crop-dark.json"), JSON.stringify({ W, H, quad }));
}

/* ------------------------------------- 3. dark card on a light table top */
{
  const W = 1280;
  const H = 960;
  const img = makeImage(W, H);
  img.fill(0, 0, W, H, [222, 216, 205]);
  const quad = [
    [340, 250],
    [950, 230],
    [960, 660],
    [330, 680],
  ];
  drawSheet(img, quad, [52, 54, 62], [210, 212, 218], { lines: 8 });
  img.noise(7, 11);
  writePng("crop-darkcard.png", img);
  writeFileSync(join(here, "crop-darkcard.json"), JSON.stringify({ W, H, quad }));
}
