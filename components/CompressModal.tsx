"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Download, FileArchive, Gauge, Loader2, Zap } from "lucide-react";
import { useShell } from "./AppShell";
import { useStore } from "@/lib/store";
import { Button, Field, Modal, ProgressBar, Segmented, Slider } from "./ui";
import { compressPdf } from "@/lib/compress";
import { downloadBlob, safeFileName } from "@/lib/share";
import { formatBytes } from "@/lib/utils";
import { pdfToImagesZip } from "@/lib/compress";
import { pdfStore } from "@/lib/pdfStore";
import { dataUrlBytes } from "@/lib/utils";

const PRESETS = [
  { id: "screen", label: "Screen", dpi: 96, q: 62, hint: "email · smallest" },
  { id: "balanced", label: "Balanced", dpi: 150, q: 78, hint: "default" },
  { id: "print", label: "Print", dpi: 220, q: 88, hint: "sharp text" },
] as const;

export default function CompressModal() {
  const shell = useShell();
  const store = useStore();
  const open = shell.modal === "compress";

  const [preset, setPreset] = useState<(typeof PRESETS)[number]["id"]>("balanced");
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(78);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ before: number; after: number; bytes: Uint8Array } | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) {
      setResult(null);
      setProgress(0);
      setWorking(false);
    }
  }, [open]);

  const applyPreset = (id: (typeof PRESETS)[number]["id"]) => {
    setPreset(id);
    const p = PRESETS.find((x) => x.id === id)!;
    setDpi(p.dpi);
    setQuality(p.q);
  };

  const estimate = () => {
    // rough estimate: pixels × bytes-per-pixel
    const px = store.pages.reduce((n, p) => n + (p.wPt / 72) * (p.hPt / 72) * dpi * dpi, 0);
    const bpp = preset === "screen" ? 0.11 : preset === "balanced" ? 0.16 : 0.26;
    return Math.max(40_000, px * bpp);
  };

  const run = async () => {
    setWorking(true);
    setProgress(0);
    try {
      const res = await compressPdf(store.pages, store.annotations, { dpi, quality: quality / 100, format: "jpeg" }, (done, total) =>
        setProgress(done / total)
      );
      const blob = new Blob([res.bytes as BlobPart], { type: "application/pdf" });
      const before =
        pdfStore.totalSourceBytes() +
        store.pages.reduce((n, p) => n + (p.source.kind === "image" ? dataUrlBytes(p.source.dataUrl) : 0), 0);
      setResult({ before, after: blob.size, bytes: res.bytes });
      shell.toast(`Compressed to ${formatBytes(blob.size)}`);
    } catch (err) {
      console.error(err);
      shell.toast("Compression failed", "err");
    } finally {
      setWorking(false);
    }
  };

  const saveJpegPdf = () => {
    if (!result) return;
    const blob = new Blob([result.bytes as BlobPart], { type: "application/pdf" });
    downloadBlob(blob, safeFileName(`${store.docName}-compressed`, "compressed", "pdf"));
  };

  const saveZip = async () => {
    setWorking(true);
    try {
      const blob = await pdfToImagesZip(
        store.pages,
        store.annotations,
        { dpi, quality: quality / 100, format: "jpeg" },
        store.docName,
        (d, t) => setProgress(d / t)
      );
      downloadBlob(blob, safeFileName(`${store.docName}-images`, "pages", "zip"));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => shell.close()}
      title="Compress & resize"
      subtitle="Re-encodes each page as a JPEG at the size you pick — the fastest way to shrink phone scans"
      width="max-w-lg"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-dim">Estimate updates live — nothing is uploaded</span>
          <div className="flex gap-2">
            {result ? (
              <>
                <Button variant="outline" onClick={() => void saveZip()}>
                  <FileArchive size={15} /> Images ZIP
                </Button>
                <Button variant="primary" onClick={saveJpegPdf}>
                  <Download size={15} /> Download PDF
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={() => shell.close()}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={() => void run()} disabled={working || !store.pages.length}>
                  {working ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
                  {working ? "Compressing…" : "Compress"}
                </Button>
              </>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => applyPreset(p.id)}
              className={`rounded-xl border p-2.5 text-left transition-colors ${
                preset === p.id ? "border-accent bg-accent/10" : "border-line bg-panel2 hover:border-line2"
              }`}
            >
              <p className="text-[12.5px] font-medium text-ink">{p.label}</p>
              <p className="text-[10.5px] text-dim">{p.hint}</p>
              <p className="mt-1 text-[10.5px] text-muted">
                {p.dpi} DPI · q{p.q}
              </p>
            </button>
          ))}
        </div>

        <Field label="Resolution" hint={`${dpi} DPI`}>
          <Slider value={dpi} min={72} max={300} step={6} onChange={(v) => { setDpi(v); setPreset("balanced" as typeof preset); }} />
        </Field>
        <Field label="JPEG quality" hint={`${quality}%`}>
          <Slider value={quality} min={35} max={95} onChange={setQuality} suffix="%" />
        </Field>

        <div className="flex items-center justify-between rounded-xl border border-line bg-panel2/60 px-3 py-2.5 text-[12px]">
          <span className="flex items-center gap-1.5 text-muted">
            <Gauge size={13} /> estimated output
          </span>
          <span className="tabular flex items-center gap-1.5 font-medium text-ink">
            {formatBytes(estimate())}
            <ArrowRight size={12} className="text-dim" />
            <span className="text-good">{formatBytes(estimate() * (quality / 100) * 0.55)}</span>
          </span>
        </div>

        {working ? <ProgressBar value={progress} /> : null}

        {result ? (
          <div className="animate-pop rounded-xl border border-good/30 bg-good/10 p-3 text-[12.5px] text-good">
            Done — {formatBytes(result.after)} for {store.pages.length} page(s)
            {result.before > result.after ? (
              <span className="text-good/80">
                {" "}
                · saved {Math.round((1 - result.after / result.before) * 100)}% vs {formatBytes(result.before)} original
              </span>
            ) : null}
          </div>
        ) : null}

        <p className="text-[11px] leading-relaxed text-dim">
          Compressed files are flattened images: text is no longer selectable unless you keep the OCR layer (run OCR before
          compressing and the invisible text layer is preserved in the PDF export instead).
        </p>
      </div>
    </Modal>
  );
}
