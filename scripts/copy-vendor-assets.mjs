#!/usr/bin/env node
/**
 * Copies pdfjs-dist / tesseract.js runtime assets from node_modules into /public.
 * Runs automatically on `npm install` (postinstall), so Vercel builds get the
 * worker, cmaps, standard fonts and wasm binaries without committing them.
 *
 *   npm run assets         -> worker + cmaps + fonts + wasm + tesseract core
 *   npm run assets:langs   -> additionally vendors eng.traineddata (~3MB) for
 *                            fully offline OCR. Without it tesseract.js lazily
 *                            downloads language data from jsDelivr on first use.
 */
import { cpSync, existsSync, mkdirSync, copyFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pub = join(root, "public");

function pkgDir(name) {
  // resolve the package.json so this works with hoisted/workspace installs
  return dirname(require.resolve(`${name}/package.json`));
}

function copyDir(from, to) {
  if (!existsSync(from)) {
    console.warn(`[assets] skip (missing): ${from}`);
    return;
  }
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
  const n = readdirSync(to).length;
  console.log(`[assets] ${to.replace(root + "/", "")}  (${n} files)`);
}

try {
  const pdfjs = pkgDir("pdfjs-dist");

  // 1) PDF.js worker — must sit at the root so `workerSrc = '/pdf.worker.min.mjs'` works.
  copyFileSync(join(pdfjs, "build/pdf.worker.min.mjs"), join(pub, "pdf.worker.min.mjs"));
  console.log("[assets] pdf.worker.min.mjs");

  // 2) CJK font maps + standard 14 fonts + openjpeg/jbig2/qcms wasm
  copyDir(join(pdfjs, "cmaps"), join(pub, "cmaps"));
  copyDir(join(pdfjs, "standard_fonts"), join(pub, "standard_fonts"));
  copyDir(join(pdfjs, "wasm"), join(pub, "pdf-wasm"));
} catch (err) {
  console.warn("[assets] pdfjs-dist not installed yet:", err.message);
}

try {
  // 3) tesseract.js worker + core (LSTM builds only — ~11MB instead of ~30MB)
  const tess = pkgDir("tesseract.js");
  const core = pkgDir("tesseract.js-core");
  // Clean first so a previous run's stale files never linger.
  rmSync(join(pub, "vendor/tesseract"), { recursive: true, force: true });
  mkdirSync(join(pub, "vendor/tesseract"), { recursive: true });

  copyFileSync(join(tess, "dist/worker.min.js"), join(pub, "vendor/tesseract/worker.min.js"));
  console.log("[assets] vendor/tesseract/worker.min.js");

  // Each *.wasm.js already embeds its wasm payload as base64, so the standalone
  // .wasm siblings (≈8 MB) are redundant. Ship the three LSTM builds:
  // relaxedsimd → simd → plain scalar, picked by tesseract at runtime.
  const coreFiles = readdirSync(core).filter(
    (f) => f.startsWith("tesseract-core") && f.endsWith("-lstm.wasm.js")
  );
  for (const f of coreFiles) copyFileSync(join(core, f), join(pub, "vendor/tesseract", f));
  console.log(`[assets] vendor/tesseract  (${coreFiles.length} core builds)`);
} catch (err) {
  console.warn("[assets] tesseract.js not installed yet:", err.message);
}

// 4) Optional: vendor English language data so OCR works fully offline.
const LANGS = ["eng"];
const wantsLangs = process.argv.includes("--langs");
if (wantsLangs) {
  mkdirSync(join(pub, "vendor/tessdata"), { recursive: true });
  for (const lang of LANGS) {
    const dest = join(pub, "vendor/tessdata", `${lang}.traineddata`);
    if (existsSync(dest)) continue;
    const url = `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[assets] could not fetch ${lang}: ${res.status}`);
      continue;
    }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    console.log(`[assets] vendor/tessdata/${lang}.traineddata`);
  }
}

// 5) Emit an offline manifest so the service worker knows exactly which files
//    make the app fully self-contained (this list is what gets precached).
{
  const { writeFileSync } = await import("node:fs");
  const OFFLINE_DIRS = ["cmaps", "standard_fonts", "pdf-wasm", "vendor/tesseract", "vendor/tessdata"];
  const urls = [];
  const walk = (rel) => {
    const abs = join(pub, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (!entry.name.startsWith(".")) urls.push(`/${child}`);
    }
  };
  for (const dir of OFFLINE_DIRS) walk(dir);
  const worker = join(pub, "pdf.worker.min.mjs");
  if (existsSync(worker)) urls.unshift("/pdf.worker.min.mjs");

  urls.sort();
  writeFileSync(join(pub, "offline-assets.json"), JSON.stringify({ version: Date.now(), urls }, null, 0));
  let bytes = 0;
  for (const u of urls) {
    try { bytes += statSync(join(pub, u.slice(1))).size; } catch {}
  }
  console.log(`[assets] offline-assets.json  (${urls.length} files, ${(bytes / 1048576).toFixed(1)} MB)`);
}

console.log("[assets] done.");
