"use client";

import { Check, SquareCheck } from "lucide-react";

export function Root({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={`grid h-[22px] w-[22px] place-items-center rounded-[6px] border shadow-sm transition-colors lg:h-[18px] lg:w-[18px] lg:shadow-none ${
        checked ? "border-accent bg-accent text-white" : "border-white/40 bg-black/50 text-transparent hover:border-white"
      }`}
      aria-pressed={checked}
      aria-label="Select page"
    >
      <Check size={14} strokeWidth={3} />
    </button>
  );
}

export function Icon() {
  return <SquareCheck size={13} />;
}
