#!/usr/bin/env node
/**
 * Stamps the service worker's cache version with this build's identity.
 *
 * Why: `public/sw.js` used to carry a literal `pdfsl-v3`. Because the cache
 * name never changed, `activate` had nothing to evict — every deploy's chunks
 * piled into one cache (measured at 217 entries) and a returning visitor could
 * keep being served assets from builds that no longer existed. That is the
 * "it broke after the new push, then fixed itself" pattern: new HTML
 * (network-first) pointing at chunks the old cache had no reason to drop.
 *
 * Runs on `prebuild`, so every deploy gets a fresh name and every older cache
 * is deleted on activation. Falls back to a timestamp so a plain local build
 * behaves the same way Vercel's does.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "public", "sw.js");

const sha = (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "").slice(0, 7);
const buildId = sha || String(Date.now());

const src = readFileSync(file, "utf8");
const RE = /^const VERSION = "[^"]*";$/m;
if (!RE.test(src)) {
  console.warn("[stamp-sw] no VERSION line found — leaving sw.js untouched");
} else {
  writeFileSync(file, src.replace(RE, `const VERSION = "pdfsl-${buildId}";`));
  console.log(`[stamp-sw] cache version -> pdfsl-${buildId}`);
}
