# PDF Scan Lite

A lightweight, fully client-side PDF scanner and editor. Scan with a phone camera, clean up the
page, OCR it, annotate, sign, reorder, compress and export — with **nothing ever leaving the
device**. There are no API routes, no database, no upload endpoint and no server cost beyond
static hosting.

> **Never run `npm run build` locally before pushing.** `.next/` is git-ignored, so it will not
> be uploaded, and Vercel runs its own clean `npm install` + `npm run build`. If a local build
> confuses your git client, run `rm -rf .next` first.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [Logo] PDF Scan Lite │ Open  Scan │ ↶ ↷ ⟲ ⟳ │ filename │  OCR  │ Export  ⋯   │
├──────────────┬───────────────────────────────────────────────────────────────┤
│ PAGES        │ Page 1 of 3 · 595 × 842 pt · 46 words          − Fit + ⤢        │
│ ┌──────────┐ │ ┌───────────────────────────────────────────────────────────┐ │
│ │ thumb 1  │ │ │                                                           │ │
│ └──────────┘ │ │            page canvas + OCR word layer                   │ │
│ ┌──────────┐ │ │            + live ink layer + selection handles           │ │
│ │ thumb 2  │ │ │                                                           │ │
│ └──────────┘ │ └───────────────────────────────────────────────────────────┘ │
│ +Blank +Scan │        [ ▸ │ A │ ✎ │ 🖍 │ ⌫ │ ✍ │ 🖼 │ 🗑 ]                  │
└──────────────┴───────────────────────────────────────────────────────────────┘
```

---

## 1. Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Framework | **Next.js 16** (App Router, TypeScript) | One static page, zero server work; deploys to Vercel with no config. |
| Styling | **Tailwind CSS v4** + a small component kit (`components/ui.tsx`) | No runtime CSS-in-JS, tiny payload. |
| Icons | **lucide-react** | Tree-shaken, consistent 16px set. |
| PDF rendering | **pdfjs-dist 5.4.624** | High-fidelity Canvas rendering; worker + cmaps + fonts + WASM served from `/public`. |
| PDF writing | **pdf-lib** | Merge/split/reorder, vector text, images, native rotations, redaction boxes. |
| OCR | **tesseract.js 7** (WASM in a Web Worker) | Tesseract LSTM core, English data vendored in `public/vendor`. |
| Drawing/selection | **HTML5 Canvas** + pointer events | One canvas for the page + annotations, one for the live stroke; DOM handles for text/images. |
| Drag & drop | **@dnd-kit/core + sortable** | Accessible, pointer + keyboard reordering of thumbnails. |
| ZIP | **jszip** | Multi-page PDF→image export. |
| Offline | hand-written **service worker** (`public/sw.js`) | Caches the shell + vendor assets; OCR/editing keep working offline. |

Deliberately **not** used: OpenCV.js (a mask-based edge detector in `lib/imaging.ts` is ~150 lines
and a fraction of the download), Fabric.js (a plain canvas is faster and lets the exporter reuse
the exact same paint code), server-side anything.

---

## 2. Getting started

```bash
npm install          # postinstall copies pdfjs + tesseract assets into /public
npm run dev          # http://localhost:3000
npm run build && npm start
npm run lint
```

`npm install` runs `scripts/copy-vendor-assets.mjs`, which copies:

```
node_modules/pdfjs-dist/build/pdf.worker.min.mjs  -> public/pdf.worker.min.mjs
node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm} -> public/{cmaps,standard_fonts,pdf-wasm}
node_modules/tesseract.js/dist/worker.min.js      -> public/vendor/tesseract/worker.min.js
node_modules/tesseract.js-core/*lstm.wasm.js      -> public/vendor/tesseract/
```

These are git-ignored binaries regenerated on every install, so the repo stays small and the
assets can never drift from the installed package versions.

**Offline OCR data (optional).** `npm run assets:langs` additionally downloads
`eng.traineddata` (~3 MB) into `public/vendor/tessdata/`. With it, OCR works with no network at
all. Without it, `lib/ocr.ts` detects the missing file and falls back to tesseract.js's default
jsDelivr CDN on first use.

---

## 3. Architecture

```
app/
  layout.tsx            metadata, viewport, PWA, service-worker registration
  page.tsx              server component → <ClientShell/>
  globals.css           Tailwind v4 theme tokens + tiny utilities
components/
  ClientShell.tsx       `ssr: false` boundary (pdf.js/tesseract need `window`)
  AppShell.tsx          layout, modal/toast manager, import pipeline
  TopBar.tsx            open/scan/undo/rotate/ocr/export + shortcuts
  Thumbnails.tsx        dnd-kit reorder, duplicate/rotate/delete, multi-select
  Viewport.tsx          zoom/fit, pointer tools, OCR word taps, image drops
  ToolRail.tsx          contextual options for the active tool
  PageView.tsx          PDFCanvas (base + annotations), OcrLayer, inline text editor
  ScannerModal.tsx      camera → capture → 4-corner crop → filter → add page
  SignatureModal.tsx    bezier signature pad + PNG upload, auto-trimmed
  ExportModal.tsx       PDF / images / text targets, flatten + OCR toggles
  CompressModal.tsx     DPI/quality presets with live estimate
  WordEditModal.tsx     replace/erase a recognised word
lib/
  pdfjs.ts              lazy pdf.js loader, render helpers, blob/data-url helpers
  pdfStore.ts           source-PDF registry + capped render cache (outside React)
  pdfedit.ts            EXPORT: display coords → PDF coords, vector draw, OCR layer
  stamp.ts              RASTERISER: the single paint routine used by screen + export
  store.tsx             document state, annotations, undo/redo, tool settings
  imaging.ts            camera capture, edge detection, homography warp, filters
  ocr.ts                tesseract worker lifecycle, OCR box normalisation
  ocrBatch.ts           runs OCR page-by-page with progress
  document.ts           imports (PDF/images), thumbnails, blank pages
  compress.ts           re-rasterise PDF, PDF→images ZIP
  share.ts              Web Share L2 with download fallback
  sample.ts             demo invoice generated with pdf-lib
types/index.ts          PageMeta, Annotation union, OcrResult, …
```

### 3.1 Document model

```ts
PageMeta {
  id, source: { kind: "pdf", docId, index, pdfRotation } | { kind: "image", dataUrl, mime },
  wPt, hPt,            // displayed size at scale 1 (rotation applied)
  rotation,            // extra user rotation (0/90/180/270)
  thumb?, ocr?, ocrState?
}
```

* Pages keep a **pointer** to their source; raw PDF bytes live in `lib/pdfStore.ts` (a module-level
  map) so React state stays small. One `PdfDocRef` can back many pages, which is what makes
  merge (multiple sources) and reorder (index array) free.
* Annotations are a flat map `pageId → Annotation[]`, coordinates in **page points, top-left
  origin**. The same array is painted on screen and by the exporter.
* Rotating a page rotates the *display*, never the annotation coordinates:
  `lib/pdfedit.ts` un-rotates them on export and sets `/Rotate` on the copied page.

### 3.2 Rendering — one paint routine, two destinations

`lib/stamp.ts` holds `paintBase()` (source page or image, plus erased OCR words) and
`paintAnnotations()` (text, ink, images, redaction rectangles).

* **Screen:** `PDFCanvas` calls both into a single `<canvas>` at display scale. Because text and
  ink are painted into the page pixels, the drawing cursor never shows a mismatched DOM overlay.
* **Export:** `renderFlattenedPage()` calls the same two functions at `DPI/72` scale, so what you
  see is pixel-for-pixel what the "flatten" path writes.

Vector export (`exportPdf`) does **not** rasterise: it copies the original PDF pages with pdf-lib
and re-draws annotations as native PDF objects (text with embedded standard fonts, ink as a
single quadratic SVG path, images as embedded PNGs). Text stays selectable, file size stays small.

### 3.3 Coordinate conversion

```
screen/CSS  (x right, y down, rotation applied)
   │  y' = pageH − y − h
   ▼
PDF space  (y up, unrotated)
   │  rotateRect(rect, pageW, pageH, −rotation)
   ▼
PDF media box coordinates → page.draw*()
```

`rotateRect` / `toPdfRect` / `toPdfPoint` in `lib/pdfedit.ts` are the only place this happens, so
annotation tools never need to know about rotation.

### 3.4 OCR pipeline

1. `renderSourceCanvas()` rasterises the page (max 2200 px long side — Tesseract's sweet spot).
2. `runOcr()` sends it to the tesseract.js worker with `{ text: true, blocks: true }`
   (v6+ needs `blocks` before it will return word boxes), then converts `bbox` pixels → page points.
3. `OcrWord[]` is stored on the page. `OcrLayer` renders invisible hoverable boxes on top of the
   canvas; clicking one opens the replace dialog.
4. Replacing a word:
   * the OCR word is flagged (`conf = −1`),
   * a real `TextAnn` is inserted at the same rectangle,
   * the base rasteriser paints a white box over the flagged word (**pixel erase**),
   * the vector exporter draws an opaque white rectangle + skips the hidden text, so the original
     glyphs are **not recoverable** from the exported file,
   * on request, the invisible text layer is written with `opacity 0` so the PDF is searchable.
5. Pressing OCR a second time only processes pages that have no result yet.

### 3.5 Scanner pipeline

```
getUserMedia(facingMode: environment, 3840×2160 ideal)
   → ImageCapture.takePhoto() when available, else video frame
   → detectDocumentCorners(): downsample → Otsu mask → largest connected component
                              → gradient refine per side
   → warpPerspective(): inverse homography, bilinear sampling (pure JS, no OpenCV)
   → applyScanFilter(): vivid (white balance + contrast), grey, or Otsu B&W
   → JPEG data URL → PageMeta (A4 fit) → thumbnail + editor
```

Corner handles are draggable, and "Full frame" / "Auto-crop" are one tap away.

### 3.6 Undo/redo

`lib/store.tsx` keeps up to 40 snapshots of `{pages, annotations, currentPageId}` in a ref, plus
counters in state so the toolbar can enable/disable. Pointer-drag gestures call
`addAnnotation()` once and then `updateAnnotation()` without new snapshots, so a stroke or a drag
is one undo step.

---

## 4. Feature map

| Area | What works |
| --- | --- |
| Import | Multi-file PDF + image picker, drag & drop, sample document, phone "share target" |
| Pages | Reorder (drag or keyboard), duplicate, delete, rotate all/one, blank page, multi-select → export only those |
| Scan | Live camera, rear/front switch, HD still capture, 4-corner crop, perspective fix, 4 filters |
| Annotate | Text (5 fonts, 8–72 pt, align, colour, live multi-line editor), pen, highlighter (multiply), image stamp, signature pad/upload |
| Redact | White-out / colour-sampled rectangles, permanent pixel erase on export |
| OCR | Local LSTM engine, word boxes, click-to-replace, click-to-erase, searchable text layer on export |
| Export | PDF (vector or flattened, + text layer), PNG/JPEG per page, ZIP, `.txt` of recognised text, Web Share |
| Compress | 3 presets or custom DPI/quality, real before/after size, PDF or image-ZIP output |
| UX | Undo/redo, keyboard shortcuts, toasts, mobile layout, ⌘S/⌘O, before-unload guard, PWA + offline |

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `⌘/Ctrl+O` | Open files |
| `⌘/Ctrl+S` | Export dialog |
| `⌘/Ctrl+Z` / `⇧⌘Z` | Undo / redo |
| `⌘/Ctrl+D` | Duplicate selected annotation |
| `Del` / `Backspace` | Delete selected annotation |
| `V` `T` `P` `H` `E` | Select, Text, Pen, Highlighter, Eraser |
| `←` `→` | Previous / next page |
| `Esc` | Deselect / return to Select |
| `⌘/Ctrl+Enter` | Commit the inline text box |

---

## 5. Deploy to Vercel

```bash
# 1. push the folder to GitHub / GitLab / Bitbucket
git init && git add . && git commit -m "PDF Scan Lite"
git remote add origin git@github.com:<you>/pdf-scan-lite.git && git push -u origin main
```

2. In Vercel → **Add New… → Project → Import** the repository.
3. Leave the defaults: framework **Next.js**, build `npm run build`, output `.next`,
   install `npm install` (which triggers the asset copy). No environment variables.
4. Deploy. Add your domain if you like.

Notes

* The app is one static page — no serverless functions, no timeouts, no storage bills.
* `next.config.ts` sets long-lived `Cache-Control` for `/vendor/*` and `/pdf.worker.min.mjs`.
* Camera access requires HTTPS (Vercel gives you that). `localhost` also works.
* Other hosts work identically: `output: "export"` is not needed, but anything that runs
  `next build` does.

---

## 6. Verification

Everything below was exercised in a real Chromium build during development (`e2e/`):

| Script | Checks |
| --- | --- |
| `e2e/verify.mjs` | sample PDF → text box, pen, highlighter, eraser, page rotate → OCR → word replace → export; then PyMuPDF confirms page count, rotations, embedded text (`REPLACED`, `INVOICE`) and vector drawings. |
| `e2e/camera.mjs` | fake webcam fed a photo of a document → capture → auto-crop → filter → add page → OCR finds 100+ words. |
| `e2e/compress.mjs` | phone viewport (390×844): import → compress → real size reported. |
| `e2e/images.mjs` | image import → PDF export (embedded JPEG) → PNG export. |
| `e2e/devcheck.mjs` | `next dev` boots, sample renders, no console errors. |

Run them yourself (the app must be running on `http://127.0.0.1:3000`):

```bash
node e2e/fixtures.mjs              # generates camera-doc.png / camera-doc.y4m
npx playwright install chromium    # once
node e2e/verify.mjs                # annotations → OCR → export → PDF checks
node e2e/camera.mjs                # fake webcam → capture → crop → OCR
node e2e/compress.mjs              # mobile viewport + compression
node e2e/images.mjs                # image import → PDF / PNG export
node e2e/devcheck.mjs              # `next dev` smoke test (port 3100)
```

The scripts import `playwright-core` from a local install; run
`npm i -D playwright-core` (or change the import path) if you re-run them on your machine.

---

## 7. Known limits & good next steps

* **Encrypted PDFs** — pdf.js can render them (with an empty password prompt), but pdf-lib cannot
  copy their pages. Such pages are skipped during vector export with a toast; routing them
  through the compress/flatten path works because it re-rasterises.
* **Standard-font text only** — annotations use the PDF standard 14 fonts. Emoji/CJK and unusual
  currency signs are sanitised to WinAnsi (see `sanitize()`); custom font embedding (fontkit) is
  the natural upgrade.
* **OCR languages** — the picker is wired for `eng`; `lib/ocr.ts` already takes a language code,
  so adding more is `npm run assets:langs` + a select.
* **Very large files** — pages are rasterised on demand, but the source bytes stay in memory.
  For 300+ page scans, an OPFS/IndexedDB page cache would be the next step.
* **Handwriting** — Tesseract LSTM is fine on print, weak on cursive; signatures are stored as
  images on purpose.

Built as a reference implementation of the architecture above: identical behaviour on desktop and
mobile, zero network calls for document data.
