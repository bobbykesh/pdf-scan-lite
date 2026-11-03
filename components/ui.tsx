"use client";

import { clsx } from "clsx";
import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

/* ------------------------------------------------------------------ button */

type Variant = "primary" | "ghost" | "outline" | "danger" | "soft";

export function Button({
  children,
  variant = "ghost",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg" }) {
  return (
    <button
      {...props}
      className={clsx(
        "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-all duration-150",
        "disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" && "h-8 px-2.5 text-[12.5px]",
        size === "md" && "h-9 px-3 text-[13px]",
        size === "lg" && "h-11 px-5 text-sm",
        variant === "primary" &&
          "bg-accent text-white shadow-[0_1px_0_rgba(255,255,255,.12)_inset,0_6px_18px_-8px_#6d7cff] hover:bg-[#7d8aff] active:bg-[#5f6df0]",
        variant === "ghost" && "text-ink/90 hover:bg-panel3 active:bg-line2",
        variant === "outline" && "border border-line2 text-ink/90 hover:border-[#3a4763] hover:bg-panel2",
        variant === "soft" && "bg-panel3 text-ink hover:bg-line2",
        variant === "danger" && "bg-bad/15 text-bad hover:bg-bad/25",
        className
      )}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------- icon */

export function IconButton({
  children,
  label,
  active,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      {...props}
      title={label}
      aria-label={label}
      className={clsx(
        "relative grid h-9 w-9 place-items-center rounded-lg transition-all duration-150",
        "disabled:cursor-not-allowed disabled:opacity-35",
        active
          ? "bg-accent/20 text-[#aab2ff] shadow-[0_0_0_1px_rgba(109,124,255,.45)_inset]"
          : "text-muted hover:bg-panel3 hover:text-ink",
        className
      )}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ modal */

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = "max-w-3xl",
  bare,
  fullScreenMobile,
  clipBody,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  bare?: boolean;
  /** Phones: fill the screen like a native camera sheet instead of a dialog. */
  fullScreenMobile?: boolean;
  /** The body manages its own layout: no scrolling, it takes the full height. */
  clipBody?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div
        className={clsx(
          "absolute inset-0 animate-fade bg-black/70 backdrop-blur-[3px]",
          fullScreenMobile && "max-sm:hidden"
        )}
        onClick={onClose}
      />
      <div
        className={clsx(
          "animate-pop relative z-10 flex w-full min-w-0 flex-col overflow-hidden border border-line2 bg-panel shadow-2xl",
          fullScreenMobile
            ? "h-[100dvh] max-h-[100dvh] rounded-none border-0 sm:h-auto sm:max-h-[94dvh] sm:rounded-2xl sm:border"
            : "max-h-[94dvh] rounded-t-2xl sm:rounded-2xl",
          width
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
          </div>
          <IconButton label="Close" onClick={onClose} className="-mr-1 -mt-1">
            <X size={17} />
          </IconButton>
        </div>
        <div
          className={clsx(
            "min-h-0 min-w-0 flex-1",
            clipBody ? "flex flex-col overflow-hidden" : "scroll-thin overflow-y-auto overflow-x-hidden",
            bare ? "" : "p-5"
          )}
        >
          {children}
        </div>
        {footer ? (
          <div className="border-t border-line bg-panel px-5 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))]">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ misc */

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</span>
        {hint ? <span className="text-[11px] text-dim">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        className="range flex-1"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="tabular w-12 text-right text-xs text-muted">
        {value}
        {suffix}
      </span>
    </div>
  );
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: ReactNode; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={clsx("inline-flex rounded-lg border border-line bg-panel2 p-0.5", className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={clsx(
            "rounded-[6px] px-2.5 py-1.5 text-[12px] font-medium transition-colors",
            value === o.value ? "bg-panel3 text-ink shadow-sm" : "text-muted hover:text-ink"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        "inline-block h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent",
        className
      )}
    />
  );
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={clsx("h-1.5 w-full overflow-hidden rounded-full bg-line", className)}>
      <div
        className="h-full rounded-full bg-gradient-to-r from-accent to-accent2 transition-[width] duration-200"
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line2 bg-panel2 px-1.5 py-0.5 font-mono text-[10px] text-muted">
      {children}
    </kbd>
  );
}
