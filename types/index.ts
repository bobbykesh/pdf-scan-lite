/** Shared domain types — everything here is plain serialisable data. */

export type Rotation = 0 | 90 | 180 | 270;

export type ToolId = "select" | "text" | "pen" | "highlight" | "marker" | "erase" | "sign" | "image";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export type FontKey = "helvetica" | "helvetica-bold" | "times" | "times-bold" | "courier";

export interface BaseAnn {
  id: string;
  pageId: string;
}

export interface TextAnn extends BaseAnn {
  type: "text";
  rect: Rect;
  text: string;
  fontSize: number;
  fontKey: FontKey;
  color: string;
  align: "left" | "center" | "right";
  opacity: number;
  lineHeight: number;
}

export interface ImageAnn extends BaseAnn {
  type: "image";
  rect: Rect;
  dataUrl: string;
  opacity: number;
}

export interface DrawAnn extends BaseAnn {
  type: "draw";
  rect: Rect;
  /** absolute page coordinates in points, top-left origin */
  points: Point[];
  color: string;
  width: number;
  opacity: number;
  kind: "pen" | "highlight" | "marker" | "erase";
}

export interface RedactAnn extends BaseAnn {
  type: "redact";
  rect: Rect;
  color: string;
}

export type Annotation = TextAnn | ImageAnn | DrawAnn | RedactAnn;

export interface OcrWord {
  text: string;
  /** page points, top-left origin */
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

export interface OcrResult {
  words: OcrWord[];
  text: string;
  confidence: number;
  lang: string;
  at: number;
}

export type PageSource =
  | { kind: "pdf"; docId: string; index: number; pdfRotation: Rotation }
  | { kind: "image"; dataUrl: string; mime: string };

/** A loaded source PDF kept in memory (never uploaded). */
export interface PdfDocRef {
  id: string;
  name: string;
  bytes: Uint8Array;
}

export interface PageMeta {
  id: string;
  source: PageSource;
  /** displayed size in PDF points at scale 1 (rotation already applied) */
  wPt: number;
  hPt: number;
  /** extra user rotation on top of the source orientation */
  rotation: Rotation;
  thumb?: string;
  ocr?: OcrResult;
  ocrState?: "idle" | "running" | "done" | "error";
}

export interface DocSnapshot {
  name: string;
  pages: PageMeta[];
  annotations: Record<string, Annotation[]>;
  /** the original PDF, if the document started from one (kept outside React state for memory) */
  hasPdfSource: boolean;
}

export interface ExportSettings {
  dpi: number;
  jpegQuality: number;
  flattenOcr: boolean;
  flattenAnnotations: boolean;
}

export const DEFAULT_EXPORT: ExportSettings = {
  dpi: 200,
  jpegQuality: 0.82,
  flattenOcr: true,
  flattenAnnotations: false,
};
