"use client";

import { useEffect, useState } from "react";
import { Check, CloudOff, Download, Loader2, WifiOff } from "lucide-react";
import { useShell } from "./AppShell";

type State =
  | { kind: "checking" }
  | { kind: "unsupported" }
  | { kind: "caching"; entries: number }
  | { kind: "ready"; entries: number }
  | { kind: "empty" };

/**
 * Tells the user whether the app can run with the network switched off, and
 * offers installation when the browser supports it.
 *
 * The service worker precaches ~18 MB (pdf.js worker, cmaps, fonts, WASM
 * codecs, Tesseract engine + English data). Until that finishes, scanning and
 * OCR will fail without a connection — so this makes the state explicit
 * instead of letting it fail silently.
 */
export default function OfflineBadge({ compact = false }: { compact?: boolean }) {
  const shell = useShell();
  const [state, setState] = useState<State>({ kind: "checking" });
  const [online, setOnline] = useState(true);
  const [installEvent, setInstallEvent] = useState<Event | null>(null);
  const [installed, setInstalled] = useState(false);

  /* ---------------------------------------------------- network status */
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  /* --------------------------------------------- install (Chrome/Android) */
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    const onInstalled = () => {
      setInstalled(true);
      setInstallEvent(null);
    };
    window.addEventListener("appinstalled", onInstalled);
    const standalone =
      typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
    if (standalone) setInstalled(true);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  /* ------------------------------------------------ cache state polling */
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      setState({ kind: "unsupported" });
      return;
    }
    let alive = true;

    const ask = async () => {
      const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
      if (!reg) return null;
      return new Promise<number | null>((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => resolve(null), 2500);
        channel.port1.onmessage = (e) => {
          clearTimeout(timer);
          resolve(typeof e.data?.entries === "number" ? e.data.entries : null);
        };
        const target = reg.active ?? reg.waiting ?? reg.installing;
        try {
          target?.postMessage({ type: "cache-status" }, [channel.port2]);
        } catch {
          resolve(null);
        }
      });
    };

    const tick = async () => {
      const entries = await ask();
      if (!alive) return;
      if (entries === null) {
        setState({ kind: "checking" });
      } else if (entries >= 40) {
        setState({ kind: "ready", entries });
      } else if (entries > 0) {
        setState({ kind: "caching", entries });
      } else {
        setState({ kind: "empty" });
      }
    };

    const start = setTimeout(() => void tick(), 1500);
    const id = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearTimeout(start);
      clearInterval(id);
    };
  }, []);

  const install = async () => {
    const ev = installEvent as (Event & { prompt?: () => Promise<void> }) | null;
    if (!ev?.prompt) return;
    await ev.prompt();
    setInstallEvent(null);
  };

  // iOS has no install prompt — tell people where it lives.
  const isIos =
    typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent) && !installed;

  const label =
    state.kind === "ready"
      ? "Ready offline"
      : state.kind === "caching"
        ? `Saving offline ${Math.round((state.entries / 200) * 100)}%`
        : state.kind === "empty"
          ? "Preparing offline…"
          : state.kind === "unsupported"
            ? "Online only"
            : "Checking…";

  const tone =
    state.kind === "ready"
      ? "text-good"
      : state.kind === "caching"
        ? "text-accent"
        : state.kind === "unsupported"
          ? "text-muted"
          : "text-dim";

  const Icon =
    state.kind === "ready" ? Check : state.kind === "caching" ? Loader2 : state.kind === "unsupported" ? CloudOff : Download;

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() =>
          shell.toast(
            state.kind === "ready"
              ? `Fully cached (${state.entries} files) — airplane mode is safe.`
              : state.kind === "unsupported"
                ? "This browser does not support offline caching. Try Chrome, Edge or Safari."
                : "Downloading the PDF + OCR engines for offline use. Keep this tab open."
          )
        }
        className={`flex items-center gap-1.5 rounded-full border border-line2 bg-panel2 px-2.5 py-1 text-[11px] transition-colors hover:border-accent/40 ${tone}`}
        title="Offline readiness"
      >
        <Icon size={12} className={state.kind === "caching" ? "animate-spin" : undefined} />
        <span className={compact ? "hidden sm:inline" : ""}>{online ? label : "Offline mode"}</span>
      </button>

      {installEvent && !installed ? (
        <button
          type="button"
          onClick={() => void install()}
          className="flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
        >
          <Download size={12} /> Install
        </button>
      ) : null}

      {isIos && !installEvent ? (
        <button
          type="button"
          onClick={() =>
            shell.toast("On iPhone: tap Share ⤴ then “Add to Home Screen” to install it as an app.")
          }
          className="flex items-center gap-1.5 rounded-full border border-line2 bg-panel2 px-2.5 py-1 text-[11px] text-muted hover:border-accent/40"
        >
          <Download size={12} /> Install
        </button>
      ) : null}

      {!online ? (
        <span className="flex items-center gap-1 rounded-full bg-warn/15 px-2 py-1 text-[11px] text-warn">
          <WifiOff size={11} /> No signal
        </span>
      ) : null}
    </div>
  );
}
