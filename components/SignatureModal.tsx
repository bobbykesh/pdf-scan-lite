"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Eraser, PenLine, Trash2, Upload } from "lucide-react";
import { Button, Field, Modal, Segmented, Slider } from "./ui";
import { useShell } from "./AppShell";
import { useStore } from "@/lib/store";

type Ink = { points: { x: number; y: number }[]; color: string; width: number };

/** Trim transparent margins so the stamp hugs the strokes. */
async function trimToContent(canvas: HTMLCanvasElement): Promise<string> {
  const ctx = canvas.getContext("2d")!;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX > maxX || minY > maxY) return canvas.toDataURL("image/png");
  const pad = 8;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d")!.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

export default function SignatureModal() {
  const shell = useShell();
  const store = useStore();
  const open = shell.modal === "signature";
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inkRef = useRef<Ink[]>([]);
  const drawing = useRef<Ink | null>(null);
  const [color, setColor] = useState<"#111827" | "#1d4ed8" | "#b91c1c">("#111827");
  const [width, setWidth] = useState(2.6);
  const [empty, setEmpty] = useState(true);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const redraw = () => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const ink of inkRef.current) {
      if (ink.points.length < 2) {
        if (ink.points.length === 1) {
          ctx.beginPath();
          ctx.fillStyle = ink.color;
          ctx.arc(ink.points[0].x, ink.points[0].y, ink.width / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        continue;
      }
      ctx.beginPath();
      ctx.strokeStyle = ink.color;
      ctx.lineWidth = ink.width;
      ctx.moveTo(ink.points[0].x, ink.points[0].y);
      for (let i = 1; i < ink.points.length - 1; i++) {
        const a = ink.points[i];
        const b = ink.points[i + 1];
        ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
      const last = ink.points[ink.points.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }
  };

  useEffect(() => {
    if (!open) return;
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = c.getBoundingClientRect();
    c.width = Math.round(rect.width * dpr);
    c.height = Math.round(rect.height * dpr);
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    redraw();
    setEmpty(!inkRef.current.length);
     
  }, [open]);

  const pos = (e: React.PointerEvent) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const down = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drawing.current = { points: [pos(e)], color, width };
    inkRef.current.push(drawing.current);
    setEmpty(false);
    redraw();
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const p = pos(e);
    const pts = drawing.current.points;
    const last = pts[pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < 1.2) return;
    pts.push(p);
    redraw();
  };
  const up = () => {
    drawing.current = null;
  };

  const save = async () => {
    const c = canvasRef.current;
    if (!c) return;
    // flatten onto a transparent canvas at 2× for crisp stamps
    const out = document.createElement("canvas");
    const scale = 2;
    out.width = c.width * scale * 0.5;
    out.height = c.height * scale * 0.5;
    const ctx = out.getContext("2d")!;
    ctx.drawImage(c, 0, 0, out.width, out.height);
    const dataUrl = await trimToContent(out);
    store.setTools((t) => ({ ...t, signatureDataUrl: dataUrl }));
    store.setTool("sign");
    shell.toast("Signature ready — tap anywhere on the page to place it");
    shell.close();
  };

  const upload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      // normalise: draw onto a canvas and trim so PNG or JPEG both get a transparent margin
      const img = new Image();
      img.onload = async () => {
        const c = document.createElement("canvas");
        const max = 900;
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        c.width = img.naturalWidth * scale;
        c.height = img.naturalHeight * scale;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const trimmed = await trimToContent(c);
        store.setTools((t) => ({ ...t, signatureDataUrl: trimmed }));
        store.setTool("sign");
        shell.toast("Signature image ready — tap the page to place it");
        shell.close();
      };
      img.src = url;
    };
    reader.readAsDataURL(file);
  };

  return (
    <Modal
      open={open}
      onClose={() => shell.close()}
      title="Signature"
      subtitle="Draw with a finger, mouse or stylus — or upload a transparent PNG"
      width="max-w-2xl"
      footer={
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => { inkRef.current = []; redraw(); setEmpty(true); }} disabled={empty}>
              <Eraser size={14} /> Clear
            </Button>
            {store.tools.signatureDataUrl ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => store.setTools((t) => ({ ...t, signatureDataUrl: null }))}
                className="text-bad"
              >
                <Trash2 size={14} /> Forget saved
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => shell.close()}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={empty}>
              <Check size={15} /> Use signature
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="relative overflow-hidden rounded-xl border border-line2 bg-white">
          <canvas
            ref={canvasRef}
            className="block h-[220px] w-full touch-none"
            style={{ touchAction: "none" }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          />
          {empty ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="text-center text-[12.5px] text-slate-400">
                <PenLine className="mx-auto mb-1.5" size={20} />
                Sign here
              </div>
            </div>
          ) : null}
          <div className="pointer-events-none absolute inset-x-8 bottom-9 border-b border-dashed border-slate-200" />
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <Segmented
            value={color}
            onChange={(v) => setColor(v)}
            options={[
              { value: "#111827", label: <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-full bg-[#111827]" /> Black</span> },
              { value: "#1d4ed8", label: <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-full bg-[#1d4ed8]" /> Blue</span> },
              { value: "#b91c1c", label: <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-full bg-[#b91c1c]" /> Red</span> },
            ]}
          />
          <div className="flex min-w-[150px] flex-1 items-center gap-2">
            <span className="text-[11px] text-muted">Nib</span>
            <Slider value={Math.round(width * 10)} min={10} max={70} onChange={(v) => setWidth(v / 10)} />
          </div>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) upload(f); }} />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Upload
          </Button>
        </div>

        {store.tools.signatureDataUrl ? (
          <Field label="Saved signature">
            <div className="flex items-center gap-3 rounded-lg border border-line bg-panel2 p-2">
              { }
              <img src={store.tools.signatureDataUrl} alt="Saved signature" className="h-12 max-w-[180px] object-contain" />
              <span className="text-[11px] text-dim">Tap a page to stamp it again</span>
            </div>
          </Field>
        ) : null}

        <p className="text-[11px] leading-relaxed text-dim">
          The signature is stored as a transparent PNG in memory only — it disappears when you close the tab, and the exported
          PDF embeds it as a real image object.
        </p>
      </div>
    </Modal>
  );
}
