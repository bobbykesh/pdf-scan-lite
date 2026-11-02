/** Kept in one place so the deployment notes and the code never drift. */

export const APP_NAME = "PDF Scan Lite";
export const APP_TAGLINE = "Scan, edit, sign & OCR PDFs — entirely in your browser.";

export const DPI_PRESETS = [96, 150, 200, 300] as const;

export const HIGHLIGHT_COLORS = ["#fde68a", "#bbf7d0", "#bfdbfe", "#fecaca", "#e9d5ff"];
export const INK_COLORS = ["#111827", "#dc2626", "#2563eb", "#059669", "#7c3aed", "#ffffff"];

export const FONT_CHOICES = [
  { key: "helvetica", label: "Helvetica" },
  { key: "helvetica-bold", label: "Helvetica Bold" },
  { key: "times", label: "Times" },
  { key: "times-bold", label: "Times Bold" },
  { key: "courier", label: "Courier" },
] as const;
