"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  Check,
  Crop,
  ImageUp,
  Loader2,
  RefreshCw,
  Repeat,
  RotateCw,
  SwitchCamera,
  Upload,
  Wand2,
} from "lucide-react";
import { useShell } from "./AppShell";
import { useStore } from "@/lib/store";
import { Button, IconButton, Modal, Segmented } from "./ui";
import {
  applyScanFilterToCopy,
  captureFrame,
  detectDocumentCorners,
  filteredPreviewUrl,
  frameHasContent,
  warpPerspective,
  type ScanFilter,
} from "@/lib/imaging";
import { fitA4, uid } from "@/lib/utils";
import type { PageMeta, Point } from "@/types";

type Mode = "capture" | "crop" | "review";

const FILTER_OPTIONS = [
  { value: "original", label: "Colour" },
  { value: "vivid", label: "Vivid" },
  { value: "gray", label: "Grey" },
  { value: "bw", label: "B&W" },
];

const FULL_QUAD = (w: number, h: number): [Point, Point, Point, Point] => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];

/**
 * Preview + draggable corner handles for the crop quad.
 *
 * The image fills the container width; handles and the polygon are positioned as
 * percentages of the source bitmap, so the overlay stays perfectly aligned at any
 * viewport size (phones included).
 */
function CropStage({
  preview,
  width,
  height,
  corners,
  setCorners,
}: {
  preview: string;
  width: number;
  height: number;
  corners: [Point, Point, Point, Point];
  setCorners: (c: [Point, Point, Point, Point]) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const dragIdx = useRef<number | null>(null);
  const dragBox = useRef<{ rect: DOMRect } | null>(null);

  const pct = (v: number, total: number) => `${(v / total) * 100}%`;

  const onDown = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragIdx.current = i;
    dragBox.current = ref.current ? { rect: ref.current.getBoundingClientRect() } : null;
  };
  const onMove = (e: React.PointerEvent) => {
    const box = dragBox.current;
    if (dragIdx.current === null || !box) return;
    const x = Math.max(0, Math.min(width, ((e.clientX - box.rect.left) / box.rect.width) * width));
    const y = Math.max(0, Math.min(height, ((e.clientY - box.rect.top) / box.rect.height) * height));
    const next = [...corners] as [Point, Point, Point, Point];
    next[dragIdx.current] = { x, y };
    setCorners(next);
  };
  const onUp = () => {
    dragIdx.current = null;
    dragBox.current = null;
  };

  return (
    <div className="flex justify-center">
      <div
        ref={ref}
        className="relative mx-auto w-full max-w-[560px] overflow-hidden rounded-lg border border-line2 bg-black"
        style={{ maxHeight: "46dvh" }}
      >
        <img
          src={preview}
          alt="Captured page"
          className="mx-auto block h-auto max-h-[46dvh] w-auto max-w-full select-none object-contain"
          draggable={false}
        />
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
        >
          <polygon
            points={corners.map((c) => `${c.x},${c.y}`).join(" ")}
            fill="rgba(109,124,255,.16)"
            stroke="#8b95ff"
            vectorEffect="non-scaling-stroke"
            style={{ strokeDasharray: "7 5", strokeWidth: 2 }}
          />
        </svg>
        {corners.map((c, i) => (
          <div
            key={i}
            onPointerDown={onDown(i)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            className="absolute grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none place-items-center rounded-full border-2 border-white bg-accent/90 shadow-lg active:cursor-grabbing"
            style={{ left: pct(c.x, width), top: pct(c.y, height) }}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-white" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ScannerModal() {
  const shell = useShell();
  const store = useStore();
  const open = shell.modal === "scanner";

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const galleryRef = useRef<HTMLInputElement | null>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [mode, setMode] = useState<Mode>("capture");
  const [busy, setBusy] = useState<null | "capture" | "crop" | "save">(null);

  /**
   * `raw` is the pristine, never-mutated bitmap of the current shot.
   * `cropped` is the pristine (unfiltered) warped result.
   * Filters are only ever *rendered* from these, so switching is idempotent.
   */
  const [raw, setRaw] = useState<HTMLCanvasElement | null>(null);
  const [cropped, setCropped] = useState<HTMLCanvasElement | null>(null);
  const [corners, setCorners] = useState<[Point, Point, Point, Point] | null>(null);
  const [filter, setFilter] = useState<ScanFilter>("vivid");
  const [autoCrop, setAutoCrop] = useState(true);
  const [flash, setFlash] = useState(false);
  const [batch, setBatch] = useState(0);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const start = useCallback(
    async (facingMode: "environment" | "user") => {
      setError(null);
      setStarting(true);
      stop();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
      } catch (err) {
        const name = (err as DOMException)?.name;
        setError(
          name === "NotAllowedError"
            ? "Camera permission was blocked. Allow camera access in your browser, then try again."
            : name === "NotFoundError"
              ? "No camera found on this device — you can import photos instead."
              : "Could not start the camera. On desktop, use https:// or localhost."
        );
      } finally {
        setStarting(false);
      }
    },
    [stop]
  );

  const reset = useCallback(() => {
    setMode("capture");
    setRaw(null);
    setCropped(null);
    setCorners(null);
    setBusy(null);
  }, []);

  useEffect(() => {
    if (!open) {
      stop();
      reset();
      return;
    }
    void start(facing);
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* ---------------------------------------------------------------- previews */

  // Downscaled JPEGs, computed only when the input actually changes.
  const rawPreview = useMemo(() => (raw ? filteredPreviewUrl(raw, "original", 1000, 0.85) : ""), [raw]);
  const cropPreview = useMemo(
    () => (raw ? filteredPreviewUrl(raw, filter, 1000, 0.85) : ""),
    [raw, filter]
  );
  const reviewPreview = useMemo(
    () => (cropped ? filteredPreviewUrl(cropped, filter, 1000, 0.88) : ""),
    [cropped, filter]
  );

  /* ---------------------------------------------------------------- actions */

  const shoot = async () => {
    if (busy) return;
    setBusy("capture");
    setFlash(true);
    setTimeout(() => setFlash(false), 160);
    const video = videoRef.current;
    if (!video) {
      setBusy(null);
      return;
    }
    const track = streamRef.current?.getVideoTracks()[0];
    const canvas = await captureFrame(video, track);
    // never hand a black frame to the crop stage
    const ok = await frameHasContent(canvas);
    if (!ok) {
      setBusy(null);
      shell.toast("The camera did not return an image — hold still and capture again.");
      return;
    }
    setRaw(canvas);
    // honour the "auto-detect page edges" toggle instead of always detecting
    setCorners(autoCrop ? detectDocumentCorners(canvas) : FULL_QUAD(canvas.width, canvas.height));
    setCropped(null);
    setMode("crop");
    setBusy(null);
  };

  const confirmCrop = () => {
    if (!raw || busy) return;
    setBusy("crop");
    const quad = corners ?? FULL_QUAD(raw.width, raw.height);
    // let the spinner paint before the (synchronous) warp runs
    setTimeout(() => {
      let result = raw;
      try {
        result = warpPerspective(raw, quad, 2400).canvas;
      } catch {
        result = raw;
      }
      setCropped(result);
      setMode("review");
      setBusy(null);
    }, 30);
  };

  const commit = (another: boolean) => {
    if (!cropped || busy) return;
    setBusy("save");
    setTimeout(() => {
      // full-resolution render of the chosen look — derived from the pristine crop
      const finalCanvas = applyScanFilterToCopy(cropped, filter);
      const dataUrl = finalCanvas.toDataURL("image/jpeg", 0.92);
      const fit = fitA4(cropped.width, cropped.height);
      const page: PageMeta = {
        id: uid("pg"),
        source: { kind: "image", dataUrl, mime: "image/jpeg" },
        wPt: fit.wPt,
        hPt: fit.hPt,
        rotation: 0,
        ocrState: "idle",
      };
      store.setPages((prev) => [...prev, page]);
      if (!store.currentPageId) store.setCurrentPageId(page.id);
      setBatch((b) => b + 1);
      setBusy(null);
      if (another) {
        reset();
        if (!streamRef.current) void start(facing);
      } else {
        shell.toast(`Page ${store.pages.length + 1} added`);
        shell.close();
      }
    }, 30);
  };

  const importFromGallery = (files: FileList | null) => {
    if (!files?.length) return;
    void shell.importFiles(Array.from(files));
    shell.close();
  };

  const cycleFilter = () => {
    const order: ScanFilter[] = ["original", "vivid", "gray", "bw"];
    setFilter(order[(order.indexOf(filter) + 1) % order.length]);
  };

  const subtitle =
    mode === "capture"
      ? "Point at the page — it stays on your device"
      : mode === "crop"
        ? "Drag the corners to fit the page"
        : "Pick a look, then add the page";

  return (
    <Modal
      open={open}
      onClose={() => shell.close()}
      title="HD document scanner"
      subtitle={subtitle}
      width="max-w-4xl"
      bare
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
            {batch > 0 ? (
              <span className="rounded bg-good/15 px-2 py-0.5 text-good">{batch} scanned this session</span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {mode === "crop" ? (
              <>
                <Button variant="ghost" onClick={reset} disabled={!!busy}>
                  Retake
                </Button>
                <Button variant="primary" onClick={confirmCrop} disabled={!!busy}>
                  {busy === "crop" ? <Loader2 size={15} className="animate-spin" /> : <Crop size={15} />}
                  {busy === "crop" ? "Cropping…" : "Use this crop"}
                </Button>
              </>
            ) : mode === "review" ? (
              <>
                <Button variant="ghost" onClick={() => setMode("crop")} disabled={!!busy}>
                  Adjust
                </Button>
                <Button variant="outline" onClick={() => commit(true)} disabled={!!busy}>
                  <Repeat size={15} /> Scan next
                </Button>
                <Button variant="primary" onClick={() => commit(false)} disabled={!!busy}>
                  {busy === "save" ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                  {busy === "save" ? "Adding…" : "Add page"}
                </Button>
              </>
            ) : (
              <>
                <input
                  ref={galleryRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => importFromGallery(e.target.files)}
                />
                <Button variant="ghost" onClick={() => galleryRef.current?.click()}>
                  <ImageUp size={15} /> From gallery
                </Button>
                <Button variant="primary" onClick={() => void shoot()} disabled={!!error || busy === "capture"}>
                  {busy === "capture" ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />}
                  Capture
                </Button>
              </>
            )}
          </div>
        </div>
      }
    >
      <div className="bg-[#06080d] p-4 sm:p-5">
        {mode === "capture" ? (
          <div className="relative mx-auto max-w-3xl">
            <div className="relative aspect-[4/3] overflow-hidden rounded-xl border border-line2 bg-black">
              <video ref={videoRef} playsInline muted autoPlay className="h-full w-full object-contain" />
              {flash ? <div className="absolute inset-0 bg-white" /> : null}
              {/* framing guides */}
              <div className="pointer-events-none absolute inset-6 rounded-lg border-2 border-white/25">
                <span className="absolute -left-px -top-px h-5 w-5 rounded-tl-lg border-l-2 border-t-2 border-accent" />
                <span className="absolute -right-px -top-px h-5 w-5 rounded-tr-lg border-r-2 border-t-2 border-accent" />
                <span className="absolute -bottom-px -left-px h-5 w-5 rounded-bl-lg border-b-2 border-l-2 border-accent" />
                <span className="absolute -bottom-px -right-px h-5 w-5 rounded-br-lg border-b-2 border-r-2 border-accent" />
              </div>
              {starting ? (
                <div className="absolute inset-0 grid place-items-center bg-black/60">
                  <div className="flex flex-col items-center gap-3 text-sm text-muted">
                    <RefreshCw size={20} className="animate-spin text-accent" />
                    Starting camera…
                  </div>
                </div>
              ) : null}
              {error ? (
                <div className="absolute inset-0 grid place-items-center bg-black/80 p-6 text-center">
                  <div className="max-w-sm">
                    <p className="text-sm text-ink">{error}</p>
                    <div className="mt-4 flex justify-center gap-2">
                      <Button variant="outline" onClick={() => void start(facing)}>
                        <RefreshCw size={14} /> Try again
                      </Button>
                      <Button variant="primary" onClick={() => galleryRef.current?.click()}>
                        <Upload size={14} /> Import photos
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2">
                <IconButton
                  label="Switch camera"
                  className="bg-black/50 text-white hover:bg-black/70"
                  onClick={() => {
                    const f = facing === "environment" ? "user" : "environment";
                    setFacing(f);
                    void start(f);
                  }}
                >
                  <SwitchCamera size={17} />
                </IconButton>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-[11.5px] text-muted">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={autoCrop}
                  onChange={(e) => setAutoCrop(e.target.checked)}
                  className="accent-[#6d7cff]"
                />
                Auto-detect page edges
              </label>
              <span className="text-dim">·</span>
              <span>Rear camera, max sensor resolution</span>
            </div>
          </div>
        ) : mode === "crop" && raw ? (
          <div className="space-y-3">
            <CropStage
              preview={cropPreview}
              width={raw.width}
              height={raw.height}
              corners={corners ?? FULL_QUAD(raw.width, raw.height)}
              setCorners={setCorners}
            />
            <div className="flex flex-wrap items-center justify-center gap-2 text-[11.5px]">
              <Button variant="outline" size="sm" onClick={() => setCorners(FULL_QUAD(raw.width, raw.height))}>
                Full frame
              </Button>
              <Button variant="outline" size="sm" onClick={() => setCorners(detectDocumentCorners(raw))}>
                <Wand2 size={13} /> Auto-crop
              </Button>
              <Segmented value={filter} onChange={(v) => setFilter(v as ScanFilter)} options={FILTER_OPTIONS} />
            </div>
            <p className="text-center text-[11px] text-dim">
              The preview shows the selected look — the full-resolution page is rendered when you add it.
            </p>
          </div>
        ) : cropped ? (
          <div className="space-y-3">
            <div className="mx-auto flex max-w-md justify-center">
              <div className="overflow-hidden rounded-lg border border-line2 bg-white shadow-sm">
                <img
                  src={reviewPreview}
                  alt="Scanned page"
                  className="block h-auto max-h-[46dvh] w-auto max-w-full object-contain"
                  draggable={false}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Segmented value={filter} onChange={(v) => setFilter(v as ScanFilter)} options={FILTER_OPTIONS} />
              <Button variant="ghost" size="sm" onClick={() => setMode("crop")}>
                <RotateCw size={13} /> Re-crop
              </Button>
              <Button variant="ghost" size="sm" onClick={cycleFilter}>
                <Wand2 size={13} /> Cycle look
              </Button>
            </div>
            <p className="text-center text-[11px] text-dim">
              Switching looks is lossless — every look is re-computed from the original capture.
            </p>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
