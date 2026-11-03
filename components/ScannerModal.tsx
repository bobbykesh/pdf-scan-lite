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
  RotateCcw,
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
  detectDocumentCornersDetailed,
  filteredPreviewUrl,
  rotateCanvas,
  frameHasContent,
  warpPerspectiveAsync,
  type ScanFilter,
} from "@/lib/imaging";
import CropStage, { type Quad } from "./CropStage";
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
  const [cropPct, setCropPct] = useState(0);
  /** Page-level rotation applied to the crop quad / finished page. */
  const [rotation, setRotation] = useState(0);

  /**
   * `raw` is the pristine, never-mutated bitmap of the current shot.
   * `cropped` is the pristine (unfiltered) warped result.
   * Filters are only ever *rendered* from these, so switching is idempotent.
   */
  const [raw, setRaw] = useState<HTMLCanvasElement | null>(null);
  const [cropped, setCropped] = useState<HTMLCanvasElement | null>(null);
  const [corners, setCorners] = useState<Quad | null>(null);
  const [cropConfidence, setCropConfidence] = useState<number | null>(null);
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
    setRotation(0);
    setCropConfidence(null);
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
  /**
   * The crop stage needs the WHOLE capture at its native aspect ratio: the
   * corner handles are positioned against the full frame, so any other aspect
   * would make the handles drift away from the page. (The un-squeezed preview
   * below is a separate thing — see `cropPreviewUrl` usage in review mode.)
   */
  const cropPreview = useMemo(
    () => (raw ? filteredPreviewUrl(raw, filter, 1100, 0.86) : ""),
    [raw, filter]
  );
  const reviewPreview = useMemo(() => {
    if (!cropped) return "";
    /*
     * `cropped` is already the right way up: the rotation is applied to the
     * bitmap when it is set (auto-orientation after cropping, and the rotate
     * buttons), so the preview and the saved page can never disagree.
     */
    return filteredPreviewUrl(cropped, filter, 1000, 0.88);
  }, [cropped, filter]);

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
    if (autoCrop) {
      const det = detectDocumentCornersDetailed(canvas);
      setCorners(det.corners);
      setCropConfidence(det.found ? det.confidence : 0);
    } else {
      setCorners(FULL_QUAD(canvas.width, canvas.height));
      setCropConfidence(null);
    }
    setCropped(null);
    setMode("crop");
    setBusy(null);
  };

  const confirmCrop = async () => {
    if (!raw || busy) return;
    setBusy("crop");
    setCropPct(0);
    const quad = corners ?? FULL_QUAD(raw.width, raw.height);
    let result = raw;
    try {
      // Tiled + yielding, so the dialog never freezes while it works.
      result = (await warpPerspectiveAsync(raw, quad, {
        maxSide: 2400,
        onProgress: (f) => setCropPct(Math.round(f * 100)),
      })).canvas;
    } catch {
      result = raw;
    }
    setCropped(result);
    setRotation(0);
    setMode("review");
    setBusy(null);
  };

  const commit = (another: boolean) => {
    if (!cropped || busy) return;
    setBusy("save");
    setTimeout(() => {
      // full-resolution render of the chosen look — derived from the pristine crop
      const finalCanvas = applyScanFilterToCopy(cropped, filter);
      const dataUrl = finalCanvas.toDataURL("image/jpeg", 0.92);
      /*
       * `cropped` is already rotated (review bakes the rotation into a new
       * bitmap so the layout box matches what is on screen), so the page keeps
       * rotation 0: its width/height are the real, upright dimensions, and a
       * non-zero meta rotation would make paintBase draw it sideways again.
       */
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

  /**
   * Turn the scanned page by a quarter turn.
   *
   * The bitmap itself is rotated — CSS rotation leaves the layout box alone, so
   * a 90° turn used to overflow and clip the page. The dial keeps counting so
   * the user can see which way up they are.
   */
  const turn = (delta: number) => {
    if (!cropped) return;
    setCropped(rotateCanvas(cropped, delta));
    setRotation((r) => (r + delta) % 360);
  };

  const cycleFilter = () => {
    const order: ScanFilter[] = ["original", "vivid", "gray", "bw"];
    setFilter(order[(order.indexOf(filter) + 1) % order.length]);
  };

  const rotated = rotation % 180 !== 0;

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
      fullScreenMobile
      clipBody
      tallBody
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
                  {busy === "crop" ? `Cropping ${cropPct}%` : "Use this crop"}
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
      <div
        className={
          mode === "capture"
            ? "flex min-h-0 flex-1 flex-col bg-black p-0 sm:p-4"
            : "flex min-h-0 flex-1 flex-col bg-[#06080d] p-3 sm:p-4"
        }
      >
        {mode === "capture" ? (
          <div className="relative mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
            {/*
              Phones: the viewfinder IS the sheet (full-bleed, tall) so the
              document can be framed from a normal distance — the old 4:3 box
              was so short that people had to step back to fit a page in.
              Larger screens keep the 4:3 frame, which matches the capture.
            */}
            <div
              className="relative mx-auto min-h-0 w-full flex-1 overflow-hidden bg-black max-lg:rounded-none lg:aspect-[4/3] lg:h-auto lg:max-h-[min(56dvh,520px)] lg:flex-none lg:rounded-xl lg:border lg:border-line2"
            >
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
            <div className="mt-3 flex flex-wrap items-center justify-center gap-3 text-[11.5px] text-muted max-sm:hidden">
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
          <div className="flex h-full min-h-0 flex-col gap-2.5">
            {/* 4:3 viewfinder — the same frame the camera previewed in. */}
            <div className="min-h-0 flex-1">
              <CropStage
                preview={cropPreview}
                width={raw.width}
                height={raw.height}
                corners={corners ?? FULL_QUAD(raw.width, raw.height)}
                setCorners={setCorners}
                busy={busy === "crop"}
                onAutoCrop={() => {
                  const det = detectDocumentCornersDetailed(raw);
                  setCorners(det.corners);
                  setCropConfidence(det.found ? det.confidence : 0);
                }}
                onReset={() => {
                  setCorners(FULL_QUAD(raw.width, raw.height));
                  setCropConfidence(null);
                }}
              />
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCorners(FULL_QUAD(raw.width, raw.height));
                  setCropConfidence(null);
                }}
              >
                Full frame
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const det = detectDocumentCornersDetailed(raw);
                  setCorners(det.corners);
                  setCropConfidence(det.found ? det.confidence : 0);
                }}
              >
                <Wand2 size={13} /> Auto-crop
              </Button>
              <Segmented value={filter} onChange={(v) => setFilter(v as ScanFilter)} options={FILTER_OPTIONS} />
            </div>

            <p className="text-center text-[11px] text-dim">
              {cropConfidence === null
                ? "Drag the corner dots, or drag the middle of the page to move the whole frame."
                : cropConfidence < 0.35
                  ? "Page edges not clear — drag the corners to fit the sheet."
                  : `Page detected (${Math.round(cropConfidence * 100)}% match) — nudge the corners if needed.`}
            </p>
          </div>
        ) : cropped ? (
          <div className="flex h-full min-h-0 flex-col gap-2.5">
            {/* Big, upright preview — rotate here before adding the page. */}
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
              <div className="overflow-hidden rounded-lg border border-line2 bg-white shadow-sm">
                {/*
                  CSS rotate() does not change the layout box, so a 90°/270° turn
                  overflows. For those angles the layout is constrained to the
                  swapped dimensions, which keeps the rotated sheet on screen.
                */}
                { }
                <img
                  src={reviewPreview}
                  alt="Scanned page"
                  className="block h-auto w-auto max-w-full object-contain"
                  /* Fill the taller viewfinder the crop stage now uses, so the
                     desktop review is not a small card floating in empty space. */
                  style={{ maxHeight: "min(62dvh, 640px)" }}
                  draggable={false}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2">
              <div className="flex items-center gap-1 rounded-lg border border-line2 bg-panel2 p-1">
                <IconButton
                  label={rotation ? `Rotate left (currently ${rotation}°)` : "Rotate left"}
                  onClick={() => turn(270)}
                >
                  <RotateCcw size={16} />
                </IconButton>
                <span className="min-w-[38px] text-center text-[11.5px] tabular-nums text-muted">{rotation}°</span>
                <IconButton label="Rotate right" onClick={() => turn(90)}>
                  <RotateCw size={16} />
                </IconButton>
              </div>

              <Segmented value={filter} onChange={(v) => setFilter(v as ScanFilter)} options={FILTER_OPTIONS} />
            </div>

            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setMode("crop")}>
                <Crop size={13} /> Adjust crop
              </Button>
              <Button variant="ghost" size="sm" onClick={cycleFilter}>
                <Wand2 size={13} /> Next look
              </Button>
            </div>

            <p className="text-center text-[11px] text-dim">
              Rotate until the text reads left-to-right, then add the page.
            </p>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
