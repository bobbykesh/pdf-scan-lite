"use client";

import { useEffect, useRef, useState } from "react";
import { Eraser, Loader2, Replace, ScanText, Trash2 } from "lucide-react";
import { useShell } from "./AppShell";
import { useStore } from "@/lib/store";
import { Button, Modal } from "./ui";

export default function WordEditModal() {
  const shell = useShell();
  const store = useStore();
  const open = shell.modal === "word";
  const editing = shell.editingWord;
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setText(editing?.word.text ?? "");
      setTimeout(() => inputRef.current?.select(), 30);
    }
  }, [open, editing]);

  if (!editing) return null;
  const { word, pageId } = editing;
  const page = store.pages.find((p) => p.id === pageId);
  const replaced = page?.ocr?.words.filter((w) => w.conf === -1).length ?? 0;

  return (
    <Modal
      open={open}
      onClose={() => shell.close()}
      title="Edit recognised text"
      subtitle="The word is painted out and rewritten in the page's own ink — no white box left behind"
      width="max-w-md"
      footer={
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="danger"
            size="md"
            onClick={() => {
              store.deleteOcrWord(pageId, word);
              shell.toast("Word erased from the page");
              shell.close();
            }}
          >
            <Trash2 size={14} /> Erase word
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => shell.close()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                store.replaceOcrWord(pageId, word, text.trim() || "");
                shell.toast("Text replaced");
                shell.close();
              }}
              disabled={!text.trim()}
            >
              <Replace size={14} /> Replace
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="rounded-lg border border-line bg-panel2 px-3 py-2">
          <p className="text-[10.5px] uppercase tracking-wider text-dim">recognised</p>
          <p className="mt-0.5 font-mono text-[13px] text-ink">{word.text}</p>
          <p className="mt-1 flex items-center gap-1 text-[10.5px] text-muted">
            <ScanText size={11} /> confidence {Math.round(word.conf)}% · {Math.round(word.w)}×{Math.round(word.h)} pt
          </p>
        </div>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              store.replaceOcrWord(pageId, word, text.trim());
              shell.close();
            }
          }}
          className="w-full rounded-lg border border-line2 bg-panel px-3 py-2.5 text-[14px] text-ink outline-none focus:border-accent"
          placeholder="New text…"
        />
        <div className="flex items-start gap-2 rounded-lg bg-warn/10 px-2.5 py-2 text-[11px] leading-relaxed text-warn">
          <Eraser size={13} className="mt-0.5 shrink-0" />
          <span>
            The original word is destroyed, not covered: it is painted out with the paper colour sampled around it, so the old text
            cannot be copied from the export and the patch does not show. {replaced} word(s) already edited on this page.
          </span>
        </div>
        <p className="flex items-center gap-1 text-[10.5px] text-dim">
          <Loader2 size={10} /> Tip: click any highlighted word on the page to change it, or press Enter to apply.
        </p>
      </div>
    </Modal>
  );
}
