"use client";

import { useRef, useState } from "react";
import {
  ArrowRight,
  Camera,
  FileText,
  Fingerprint,
  ScanText,
  ShieldCheck,
  Sparkles,
  Upload,
  WifiOff,
} from "lucide-react";
import { useShell } from "./AppShell";
import { Button } from "./ui";

export default function Welcome() {
  const shell = useShell();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <div className="scroll-thin relative flex-1 overflow-y-auto">
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.55]"
        style={{
          background:
            "radial-gradient(900px 420px at 50% -8%, rgba(109,124,255,.20), transparent 70%), radial-gradient(700px 380px at 85% 10%, rgba(167,139,250,.12), transparent 70%)",
        }}
      />
      <div className="relative mx-auto flex max-w-3xl flex-col items-center px-5 pb-16 pt-10 text-center sm:pt-16">
        <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-line2 bg-panel/70 px-3 py-1 text-[11.5px] text-muted backdrop-blur">
          <ShieldCheck size={13} className="text-good" />
          Files never leave this device
          <span className="h-1 w-1 rounded-full bg-line2" />
          <WifiOff size={12} />
          works offline
        </span>

        <h1 className="max-w-2xl text-balance text-[30px] font-semibold leading-[1.1] tracking-tight sm:text-[42px]">
          Scan, edit, sign and OCR
          <span className="bg-gradient-to-r from-[#9aa4ff] via-[#c4b5fd] to-[#7dd3fc] bg-clip-text text-transparent"> any PDF</span>
        </h1>
        <p className="mt-3 max-w-xl text-pretty text-[13.5px] leading-relaxed text-muted sm:text-sm">
          A tiny in-browser studio: HD camera scanning with edge detection, text recognition, annotations,
          signatures, page management and one-click compression. No uploads, no accounts, no server bill.
        </p>

        <div className="mt-8 flex w-full flex-col items-stretch gap-2.5 sm:w-auto sm:flex-row">
          <Button variant="primary" size="lg" onClick={() => shell.open("scanner")} className="justify-center">
            <Camera size={17} /> Scan with camera
          </Button>
          <Button variant="outline" size="lg" onClick={() => fileRef.current?.click()} className="justify-center">
            <Upload size={17} /> Open PDF or image
          </Button>
          <Button variant="ghost" size="lg" onClick={() => void shell.loadSample()} className="justify-center">
            <Sparkles size={16} /> Try a sample
          </Button>
        </div>

        <input
          ref={fileRef}
          type="file"
          multiple
          accept="application/pdf,image/*"
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void shell.importFiles(files);
          }}
        />

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void shell.importFiles(Array.from(e.dataTransfer.files ?? []));
          }}
          onClick={() => fileRef.current?.click()}
          className={`mt-6 w-full cursor-pointer rounded-2xl border-2 border-dashed px-6 py-7 text-center transition-colors ${
            dragging ? "border-accent bg-accent/10" : "border-line2 bg-panel/40 hover:border-[#3a4763] hover:bg-panel/70"
          }`}
        >
          <FileText size={20} className="mx-auto mb-2 text-dim" />
          <p className="text-[13px] text-ink/90">
            Drop PDFs or photos here <span className="text-dim">— multiple files merge into one document</span>
          </p>
        </div>

        <div className="mt-10 grid w-full gap-2.5 text-left sm:grid-cols-3">
          {[
            {
              icon: <Camera size={16} />,
              title: "HD scanner",
              body: "Rear camera, auto edge detection, perspective fix and B&W / vivid filters.",
            },
            {
              icon: <ScanText size={16} />,
              title: "Editable OCR",
              body: "Recognise text locally, then click any word to rewrite it in place.",
            },
            {
              icon: <Fingerprint size={16} />,
              title: "True redaction",
              body: "Erasers and text replacements wipe the pixels, not just cover them.",
            },
          ].map((f) => (
            <div key={f.title} className="rounded-xl border border-line bg-panel/50 p-3.5">
              <div className="mb-1.5 flex items-center gap-2 text-accent">{f.icon}<span className="text-[12.5px] font-semibold text-ink">{f.title}</span></div>
              <p className="text-[11.5px] leading-relaxed text-muted">{f.body}</p>
            </div>
          ))}
        </div>

        <p className="mt-8 text-[11px] text-dim">
          Tip: press <kbd className="rounded border border-line2 bg-panel2 px-1 font-mono">⌘/Ctrl + O</kbd> to open a file,{" "}
          <kbd className="rounded border border-line2 bg-panel2 px-1 font-mono">V</kbd> select,{" "}
          <kbd className="rounded border border-line2 bg-panel2 px-1 font-mono">T</kbd> text,{" "}
          <kbd className="rounded border border-line2 bg-panel2 px-1 font-mono">P</kbd> pen.
        </p>

        <a
          href="https://github.com/bobbykesh/pdf-scan-lite"
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex items-center gap-1 text-[11.5px] text-muted hover:text-ink"
        >
          Read the architecture notes <ArrowRight size={12} />
        </a>

        {/*
          Ownership mark. Kept to the welcome screen — the one place with room
          to spare — so it never competes with the page area on a phone, where
          every pixel of height is already spoken for by the tool rail.
        */}
        <footer className="mt-10 w-full border-t border-line pt-5">
          <p className="text-[12px] font-medium text-ink">
            Designed by <span className="text-accent">Kesh</span> for Humanity
          </p>
          <p className="mt-1 text-[11px] text-dim">Enjoy, Humans 😉😎😎😎</p>
          <p className="mt-3 text-[10.5px] text-dim">
            © {new Date().getFullYear()} Kesh. All rights reserved.
          </p>
          <p className="mt-1 text-[10.5px] leading-relaxed text-dim">
            Released for everyone to use freely. Please keep this notice with any copy.
          </p>
        </footer>
      </div>
    </div>
  );
}
