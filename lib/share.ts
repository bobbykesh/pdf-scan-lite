"use client";

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  zip: "application/zip",
  txt: "text/plain",
};

export function safeFileName(name: string, fallback = "scanned_document", ext = "pdf") {
  const base = (name || fallback)
    .replace(/\.(pdf|docx?|png|jpe?g)$/i, "")
    .replace(/[^\w\-. ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return `${base || fallback}.${ext}`;
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export const canShareFiles = (file: File) => {
  try {
    return typeof navigator !== "undefined" && !!navigator.canShare?.({ files: [file] });
  } catch {
    return false;
  }
};

/**
 * Native share sheet on mobile (Web Share Level 2), silent download elsewhere.
 * Returns how the file left the app so the UI can say the right thing.
 */
export async function downloadOrShare(
  blob: Blob,
  fileName = "scanned_document.pdf",
  meta: { title?: string; text?: string } = {}
): Promise<"shared" | "downloaded"> {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "pdf";
  const type = blob.type || MIME_BY_EXT[ext] || "application/octet-stream";
  const file = new File([blob], fileName, { type });
  if (canShareFiles(file)) {
    try {
      await navigator.share({
        files: [file],
        title: meta.title ?? "Scanned document",
        text: meta.text ?? "Here is your PDF document.",
      });
      return "shared";
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") return "shared";
      // fall through to download
    }
  }
  downloadBlob(blob, fileName);
  return "downloaded";
}

export async function shareText(text: string, title = "Recognised text") {
  if (navigator.share) {
    try {
      await navigator.share({ text, title });
      return true;
    } catch {
      /* cancelled */
    }
  }
  await navigator.clipboard?.writeText(text).catch(() => {});
  return false;
}
