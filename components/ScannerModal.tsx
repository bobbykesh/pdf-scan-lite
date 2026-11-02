"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  Check,
  Crop,
  ImageUp,
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
import { applyScanFilter, captureFrame, detectDocumentCorners, warpPerspective, videoFrameCanvas, type ScanFilter } from "@/lib/imaging";
import { fitA4, uid } from "@/lib/utils";
import type { PageMeta, Point } from "@/types";

type Mode = "capture" | "crop" | "review";

/**
 * Preview + draggable corner handles for the crop quad.
 *
 * The image fills the container width; handles and the polygon are positioned as
 * percentages of the source bitmap, so the overlay stays perfectly aligned at any
 * viewport size (phones included).
 */
function CropStage({
  canvas,
  corners,
  setCorners,
}: {
  canvas: HTMLCanvasElement;
  corners: [Point, Point, Point, Point];
  setCorners: (c: [Point, Point, Point, Point]) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const dragIdx = useRef<number | null>(null);
  const dragBox = useRef<{ rect: DOMRect } | null>(null);
  const [preview, setPreview] = useState<string>("");

  useEffect(() => {
    setPreview(canvas.toDataURL("image/jpeg", 0.72));
  }, [canvas]);

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
    const x = Math.max(0, Math.min(canvas.width, ((e.clientX - box.rect.left) / box.rect.width) * canvas.width));
    const y = Math.max(0, Math.min(canvas.height, ((e.clientY - box.rect.top) / box.rect.height) * canvas.height));
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
      <div ref={ref} className="relative w-full max-w-[560px] overflow-hidden rounded-lg border border-line2 bg-black">
        { }
        <img src={preview} alt="Captured page" className="block h-auto w-full select-none" draggable={false} />
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`0 0 ${canvas.width} ${canvas.height}`}
          preserveAspectRatio="none"
        >
          <polygon
            points={corners.map((c) => `${c.x},${c.y}`).join(" ")}
            fill="rgba(109,124,255,.16)"
            stroke="#8b95ff"
            strokeWidth={Math.max(2, canvas.width / 380)}
            strokeDasharray={`${canvas.width / 90} ${canvas.width / 140}`}
            vectorEffect="non-scaling-stroke"
            style={{ strokeDasharray: "7 5" }}
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
            style={{ left: pct(c.x, canvas.width), top: pct(c.y, canvas.height) }}
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
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [mode, setMode] = useState<Mode>("capture");
  const [shot, setShot] = useState<HTMLCanvasElement | null>(null);
  const [corners, setCorners] = useState<[Point, Point, Point, Point] | null>(null);
  const [filter, setFilter] = useState<ScanFilter>("vivid");
  const [autoCrop, setAutoCrop] = useState(true);
  const [flash, setFlash] = useState(false);
  const [batch, setBatch] = useState(0);
  const galleryRef = useRef<HTMLInputElement | null>(null);

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

  useEffect(() => {
    if (!open) {
      stop();
      setMode("capture");
      setShot(null);
      setCorners(null);
      return;
    }
    void start(facing);
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const shoot = async () => {
    const video = videoRef.current;
    if (!video) return;
    setFlash(true);
    setTimeout(() => setFlash(false), 160);
    const track = streamRef.current?.getVideoTracks()[0];
    let canvas: HTMLCanvasElement;
    try {
      canvas = await captureFrame(video, track);
    } catch {
      canvas = videoFrameCanvas(video);
    }
    setShot(canvas);
    setCorners(autoCrop ? detectDocumentCorners(canvas) : detectDocumentCorners(canvas));
    setMode("crop");
  };

  const confirmCrop = () => {
    if (!shot) return;
    const quad = corners ?? [
      { x: 0, y: 0 },
      { x: shot.width, y: 0 },
      { x: shot.width, y: shot.height },
      { x: 0, y: shot.height },
    ];
    let canvas = shot;
    try {
      canvas = warpPerspective(shot, quad, 2400).canvas;
    } catch {
      canvas = shot;
    }
    applyScanFilter(canvas, filter);
    setShot(canvas);
    setMode("review");
  };

  const commit = async (another: boolean) => {
    if (!shot) return;
    const dataUrl = shot.toDataURL("image/jpeg", 0.92);
    const fit = fitA4(shot.width, shot.height);
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
    if (another) {
      setShot(null);
      setCorners(null);
      setMode("capture");
      if (!streamRef.current) void start(facing);
    } else {
      shell.toast(`Page ${store.pages.length + 1} added`);
      shell.close();
    }
  };

  const importFromGallery = (files: FileList | null) => {
    if (!files?.length) return;
    void shell.importFiles(Array.from(files));
    shell.close();
  };

  const toggleFilter = () => {
    if (!shot) return;
    // preview filter by re-applying to a copy
    const order: ScanFilter[] = ["original", "vivid", "gray", "bw"];
    const next = order[(order.indexOf(filter) + 1) % order.length];
    setFilter(next);
    if (mode === "review") {
      const copy = document.createElement("canvas");
      copy.width = shot.width;
      copy.height = shot.height;
      copy.getContext("2d", { alpha: false })!.drawImage(shot, 0, 0);
      setShot(applyScanFilter(copy, next));
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => shell.close()}
      title="HD document scanner"
      subtitle={mode === "capture" ? "Point at the page — it stays on your device" : mode === "crop" ? "Drag the corners to fit the page" : "Check the result"}
      width="max-w-4xl"
      bare
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
            {batch > 0 ? <span className="rounded bg-good/15 px-2 py-0.5 text-good">{batch} scanned this session</span> : null}
          </div>
          <div className="flex items-center gap-2">
            {mode === "crop" ? (
              <>
                <Button variant="ghost" onClick={() => { setMode("capture"); setShot(null); }}>
                  Retake
                </Button>
                <Button variant="primary" onClick={confirmCrop}>
                  <Crop size={15} /> Use this crop
                </Button>
              </>
            ) : mode === "review" ? (
              <>
                <Button variant="ghost" onClick={() => setMode("crop")}>
                  Adjust
                </Button>
                <Button variant="outline" onClick={() => void commit(true)}>
                  <Repeat size={15} /> Scan next
                </Button>
                <Button variant="primary" onClick={() => void commit(false)}>
                  <Check size={15} /> Add page
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
                <Button variant="primary" onClick={() => void shoot()} disabled={!!error}>
                  <Camera size={16} /> Capture
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
                <IconButton label="Switch camera" className="bg-black/50 text-white hover:bg-black/70" onClick={() => { const f = facing === "environment" ? "user" : "environment"; setFacing(f); void start(f); }}>
                  <SwitchCamera size={17} />
                </IconButton>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-[11.5px] text-muted">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={autoCrop} onChange={(e) => setAutoCrop(e.target.checked)} className="accent-[#6d7cff]" />
                Auto-detect page edges
              </label>
              <span className="text-dim">·</span>
              <span>Rear camera, max sensor resolution</span>
            </div>
          </div>
        ) : mode === "crop" && shot ? (
          <div className="space-y-3">
            <CropStage
              canvas={shot}
              corners={corners ?? detectDocumentCorners(shot)}
              setCorners={setCorners}
            />
            <div className="flex flex-wrap items-center justify-center gap-2 text-[11.5px]">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const c = shot;
                  setCorners([
                    { x: 0, y: 0 },
                    { x: c.width, y: 0 },
                    { x: c.width, y: c.height },
                    { x: 0, y: c.height },
                  ]);
                }}
              >
                Full frame
              </Button>
              <Button variant="outline" size="sm" onClick={() => setCorners(detectDocumentCorners(shot))}>
                <Wand2 size={13} /> Auto-crop
              </Button>
              <Segmented
                value={filter}
                onChange={(v) => setFilter(v)}
                options={[
                  { value: "original", label: "Colour" },
                  { value: "vivid", label: "Vivid" },
                  { value: "gray", label: "Grey" },
                  { value: "bw", label: "B&W" },
                ]}
              />
            </div>
          </div>
        ) : shot ? (
          <div className="space-y-3">
            <div className="mx-auto max-w-md overflow-hidden rounded-lg border border-line2 bg-white">
              { }
              <img src={shot.toDataURL("image/jpeg", 0.8)} alt="Scanned page" className="w-full" />
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Segmented
                value={filter}
                onChange={(v) => {
                  const copy = document.createElement("canvas");
                  copy.width = shot.width;
                  copy.height = shot.height;
                  copy.getContext("2d", { alpha: false })!.drawImage(shot, 0, 0);
                  setShot(applyScanFilter(copy, v));
                  setFilter(v);
                }}
                options={[
                  { value: "original", label: "Colour" },
                  { value: "vivid", label: "Vivid" },
                  { value: "gray", label: "Grey" },
                  { value: "bw", label: "B&W" },
                ]}
              />
              <Button variant="ghost" size="sm" onClick={() => setMode("crop")}>
                <RotateCw size={13} /> Re-crop
              </Button>
              <Button variant="ghost" size="sm" onClick={toggleFilter}>
                <Wand2 size={13} /> Cycle look
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
