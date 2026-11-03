"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Download, FileArchive, FileImage, FileText, Loader2, Share2, ShieldCheck } from "lucide-react";
import { useShell } from "./AppShell";
import { useStore } from "@/lib/store";
import { Button, Field, Modal, Segmented, Slider } from "./ui";
import { exportPdf } from "@/lib/pdfedit";
import { pdfStore } from "@/lib/pdfStore";
import { pdfToImagesZip } from "@/lib/compress";
import { pageToExportImage } from "@/lib/stamp";
import { downloadBlob, downloadOrShare, safeFileName } from "@/lib/share";
import { displaySize, formatBytes } from "@/lib/utils";
import { PDFDocument } from "pdf-lib";

type Target = "pdf" | "images" | "text";

export default function ExportModal() {
  const shell = useShell();
  const store = useStore();
  const open = shell.modal === "export";

  const [target, setTarget] = useState<Target>("pdf");
  const [flattenAnnotations, setFlatten] = useState(true);
  const [flattenOcr, setFlattenOcr] = useState(true);
  const [dpi, setDpi] = useState(200);
  const [quality, setQuality] = useState(82);
  const [working, setWorking] = useState<string | null>(null);
  const [result, setResult] = useState<{ size: number; pages: number; note: string } | null>(null);

  const only = (shell.payload as { only?: string[] } | null)?.only;
  const pages = useMemo(() => {
    if (!only?.length) return store.pages;
    // preserve the order the user sees, not the order they ticked
    return store.pages.filter((p) => only.includes(p.id));
  }, [store.pages, only]);

  useEffect(() => {
    if (open) {
      setResult(null);
      setWorking(null);
    }
  }, [open]);

  const name = safeFileName(store.docName, "scanned-document", "pdf");
  const ocrPages = pages.filter((p) => p.ocr?.words?.length).length;
  const editedWords = pages.reduce((n, p) => n + (p.ocr?.words.filter((w) => w.conf === -1).length ?? 0), 0);
  const annoCount = pages.reduce((n, p) => n + (store.annotations[p.id]?.length ?? 0), 0);

  const doExportPdf = async (share: boolean) => {
    setWorking("Building PDF…");
    try {
      const items = pages.map((p) => ({ meta: p, annotations: store.annotations[p.id] ?? [] }));
      const built = await exportPdf(items, pdfStore.refs(), { flattenOcr, flattenAnnotations }, async (meta) => {
        /*
         * Edited pages are burned to an image, so rasterise at the export DPI
         * with every annotation painted in — this is what makes a replaced
         * word part of the scan instead of a text object on top of it.
         */
        const { dataUrl } = await pageToExportImage(meta, {
          dpi,
          annotations: store.annotations[meta.id] ?? [],
          quality: quality / 100,
          format: "jpeg",
        });
        const { w, h } = displaySize(meta);
        return { dataUrl, wPt: w, hPt: h };
      });
      let bytes = built.bytes;
      if (built.skippedPages > 0) {
        shell.toast(`${built.skippedPages} page(s) could not be copied and were skipped`, "info");
      }
      // compress the stream a little more when exporting large docs
      try {
        const doc = await PDFDocument.load(bytes, { updateMetadata: false });
        bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
      } catch {
        /* keep as is */
      }
      const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
      if (share) await downloadOrShare(blob, name, { title: store.docName });
      else downloadBlob(blob, name);
      setResult({
        size: blob.size,
        pages: built.pageCount,
        note: built.ocrPages ? `${built.ocrPages} page(s) carry a searchable text layer` : "Vector content preserved",
      });
      store.markSaved();
      shell.toast(share ? "Ready to share" : `Saved ${name}`);
    } catch (err) {
      console.error(err);
      shell.toast("Export failed — try flattening the pages instead", "err");
    } finally {
      setWorking(null);
    }
  };

  const doExportImages = async () => {
    setWorking("Rendering pages…");
    try {
      const opts = { dpi, quality: quality / 100, format: "png" as const };
      const wantsZip = pages.length > 1;
      if (!wantsZip) {
        const { pageToExportImage } = await import("@/lib/stamp");
        const { blob } = await pageToExportImage(pages[0], {
          dpi,
          annotations: store.annotations[pages[0].id] ?? [],
          quality: quality / 100,
          format: "png",
        });
        downloadBlob(blob, safeFileName(store.docName, "page", "png"));
      } else {
        const blob = await pdfToImagesZip(pages, store.annotations, { ...opts, format: "png" }, store.docName, (done, total) =>
          setWorking(`Rendering ${done}/${total}…`)
        );
        downloadBlob(blob, safeFileName(store.docName, "pages", "zip"));
      }
      shell.toast("Images ready");
    } catch (err) {
      console.error(err);
      shell.toast("Could not render images", "err");
    } finally {
      setWorking(null);
    }
  };

  const doExportText = async () => {
    const text = pages
      .map((p, i) => {
        const body = p.ocr?.words?.filter((w) => w.conf !== -1).map((w) => w.text).join(" ") ?? "";
        return `— Page ${i + 1} —\n${body || "(no recognised text on this page)"}`;
      })
      .join("\n\n");
    const blob = new Blob([text], { type: "text/plain" });
    downloadBlob(blob, safeFileName(store.docName, "text", "txt"));
    shell.toast("Text file saved");
  };

  return (
    <Modal
      open={open}
      onClose={() => shell.close()}
      title="Export"
      subtitle={`${pages.length} page${pages.length === 1 ? "" : "s"} · ${annoCount} annotation${annoCount === 1 ? "" : "s"} · ${ocrPages} OCR page${ocrPages === 1 ? "" : "s"}`}
      width="max-w-xl"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[11px] text-dim">
            <ShieldCheck size={12} className="text-good" /> generated in your browser
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => shell.close()}>
              Close
            </Button>
            {target === "pdf" ? (
              <>
                <Button variant="outline" onClick={() => void doExportPdf(true)} disabled={!!working}>
                  <Share2 size={15} /> Share
                </Button>
                <Button variant="primary" onClick={() => void doExportPdf(false)} disabled={!!working}>
                  {working ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                  {working ?? "Download PDF"}
                </Button>
              </>
            ) : target === "images" ? (
              <Button variant="primary" onClick={() => void doExportImages()} disabled={!!working}>
                {working ? <Loader2 size={15} className="animate-spin" /> : <FileArchive size={15} />}
                {working ?? (pages.length > 1 ? "Download ZIP" : "Download PNG")}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void doExportText()}>
                <FileText size={15} /> Download .txt
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          {[
            { id: "pdf" as Target, icon: <FileText size={16} />, label: "PDF", hint: "vector-perfect" },
            { id: "images" as Target, icon: <FileImage size={16} />, label: "Images", hint: pages.length > 1 ? "PNG · ZIP" : "PNG" },
            { id: "text" as Target, icon: <FileArchive size={16} />, label: "Text", hint: "from OCR" },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTarget(t.id)}
              className={`rounded-xl border p-3 text-left transition-colors ${
                target === t.id ? "border-accent bg-accent/10" : "border-line bg-panel2 hover:border-line2"
              }`}
            >
              <span className={target === t.id ? "text-accent" : "text-muted"}>{t.icon}</span>
              <p className="mt-1.5 text-[13px] font-medium text-ink">{t.label}</p>
              <p className="text-[10.5px] text-dim">{t.hint}</p>
            </button>
          ))}
        </div>

        {target === "pdf" ? (
          <div className="space-y-3">
            <div className="space-y-2 rounded-xl border border-line bg-panel2/60 p-3">
              <label className="flex cursor-pointer items-start gap-2.5">
                <Toggle checked={flattenAnnotations} onChange={setFlatten} />
                <span>
                  <span className="block text-[12.5px] text-ink">Bake annotations into the page</span>
                  <span className="block text-[11px] text-muted">
                    Text, ink and signatures become permanent PDF vectors. Turn off to keep the original untouched — erases are
                    always applied.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5">
                <Toggle checked={flattenOcr} onChange={setFlattenOcr} />
                <span>
                  <span className="block text-[12.5px] text-ink">Keep the searchable text layer</span>
                  <span className="block text-[11px] text-muted">
                    {ocrPages
                      ? `${ocrPages} page(s) will be searchable and copyable in any PDF reader (invisible text).`
                      : "Run OCR first to unlock this."}
                  </span>
                </span>
              </label>
              {editedWords > 0 ? (
                <p className="rounded-lg bg-warn/10 px-2.5 py-1.5 text-[11px] text-warn">
                  {editedWords} recognised word(s) were replaced — their original pixels are erased permanently.
                </p>
              ) : null}
            </div>
            <p className="text-[11px] leading-relaxed text-dim">
              Pages keep their original resolution and vector text. Rotated pages, redactions and signatures are written in native
              PDF coordinates, so nothing is re-rasterised unless you compress.
            </p>
          </div>
        ) : target === "images" ? (
          <div className="space-y-3">
            <Field label="Resolution" hint={`${dpi} DPI`}>
              <Segmented
                value={dpi}
                onChange={setDpi}
                options={[
                  { value: 96, label: "Screen" },
                  { value: 150, label: "150" },
                  { value: 200, label: "200" },
                  { value: 300, label: "Print 300" },
                ]}
              />
            </Field>
            <Field label="Quality">
              <Slider value={quality} min={40} max={100} onChange={setQuality} suffix="%" />
            </Field>
          </div>
        ) : (
          <div className="rounded-xl border border-line bg-panel2/60 p-3 text-[12px] leading-relaxed text-muted">
            {ocrPages
              ? "Exports the recognised text of every page as a plain text file."
              : "No OCR results yet — run “OCR” from the toolbar first, or the file will only contain placeholders."}
          </div>
        )}

        {result ? (
          <div className="animate-pop rounded-xl border border-good/30 bg-good/10 p-3">
            <p className="flex items-center gap-2 text-[12.5px] font-medium text-good">
              <Check size={14} /> Exported {result.pages} page(s) · {formatBytes(result.size)}
            </p>
            <p className="mt-0.5 text-[11px] text-good/80">{result.note}</p>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`mt-0.5 h-[18px] w-[32px] shrink-0 rounded-full p-0.5 transition-colors ${checked ? "bg-accent" : "bg-line2"}`}
    >
      <span
        className={`block h-[14px] w-[14px] rounded-full bg-white transition-transform ${checked ? "translate-x-[14px]" : ""}`}
      />
    </button>
  );
}
