"use client";

import { Check, SquareCheck } from "lucide-react";

export function Root({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={`grid h-[18px] w-[18px] place-items-center rounded-[5px] border transition-colors ${
        checked ? "border-accent bg-accent text-white" : "border-white/40 bg-black/50 text-transparent hover:border-white"
      }`}
      aria-pressed={checked}
      aria-label="Select page"
    >
      <Check size={12} strokeWidth={3} />
    </button>
  );
}

export function Icon() {
  return <SquareCheck size={13} />;
}
