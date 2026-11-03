"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Annotation, FontKey, OcrResult, PageMeta, Rotation, ToolId, OcrWord } from "@/types";
import { uid } from "./utils";

export interface ToolSettings {
  color: string;
  highlightColor: string;
  fontSize: number;
  fontKey: FontKey;
  penWidth: number;
  markerWidth: number;
  eraseColor: string;
  eraseMode: "white" | "smart";
  signatureDataUrl: string | null;
}

const DEFAULT_TOOLS: ToolSettings = {
  color: "#111827",
  highlightColor: "#fde68a",
  fontSize: 16,
  fontKey: "helvetica",
  penWidth: 2,
  markerWidth: 14,
  eraseColor: "#ffffff",
  eraseMode: "white",
  signatureDataUrl: null,
};

const HISTORY_LIMIT = 40;

interface Snapshot {
  pages: PageMeta[];
  annotations: Record<string, Annotation[]>;
  currentPageId: string | null;
}

interface StoreValue {
  pages: PageMeta[];
  setPages: React.Dispatch<React.SetStateAction<PageMeta[]>>;
  annotations: Record<string, Annotation[]>;
  setAnnotations: React.Dispatch<React.SetStateAction<Record<string, Annotation[]>>>;
  currentPageId: string | null;
  currentIndex: number;
  currentPage: PageMeta | null;
  setCurrentPageId: (id: string) => void;
  goTo: (index: number) => void;

  tool: ToolId;
  setTool: (t: ToolId) => void;
  tools: ToolSettings;
  setTools: React.Dispatch<React.SetStateAction<ToolSettings>>;

  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  editingTextId: string | null;
  setEditingTextId: (id: string | null) => void;

  addAnnotation: (a: Annotation, options?: { undoable?: boolean }) => void;
  updateAnnotation: (id: string, patch: Partial<Annotation>) => void;
  removeAnnotation: (id: string) => void;
  duplicateAnnotation: (id: string) => void;
  clearPage: (pageId: string) => void;
  replaceOcrWord: (pageId: string, word: OcrWord, replacement: string) => void;
  deleteOcrWord: (pageId: string, word: OcrWord) => void;
  setPageOcr: (pageId: string, ocr: OcrResult | undefined, state?: PageMeta["ocrState"]) => void;

  rotatePage: (pageId: string, dir: 1 | -1) => void;
  rotateAll: (dir: 1 | -1) => void;

  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;

  docName: string;
  setDocName: (n: string) => void;
  dirty: boolean;
  markSaved: () => void;
  reset: () => void;
}

const Ctx = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [pages, setPagesRaw] = useState<PageMeta[]>([]);
  const [annotations, setAnnotationsRaw] = useState<Record<string, Annotation[]>>({});
  const [currentPageId, setCurrentPageIdRaw] = useState<string | null>(null);
  const [tool, setTool] = useState<ToolId>("select");
  const [tools, setTools] = useState<ToolSettings>(DEFAULT_TOOLS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [docName, setDocName] = useState("scanned-document");
  const [dirty, setDirty] = useState(false);

  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const stateRef = useRef({ pages, annotations, currentPageId });

  // mirror the latest document outside React so callbacks never go stale
  useEffect(() => {
    stateRef.current = { pages, annotations, currentPageId };
  }, [pages, annotations, currentPageId]);

  const currentIndex = useMemo(() => pages.findIndex((p) => p.id === currentPageId), [pages, currentPageId]);
  const currentPage = useMemo(() => pages.find((p) => p.id === currentPageId) ?? null, [pages, currentPageId]);

  const snapshot = useCallback((): Snapshot => {
    const s = stateRef.current;
    return {
      pages: s.pages.map((p) => ({ ...p })),
      annotations: Object.fromEntries(Object.entries(s.annotations).map(([k, v]) => [k, v.map((a) => ({ ...a }))])),
      currentPageId: s.currentPageId,
    };
  }, []);

  const [history, setHistory] = useState({ undo: 0, redo: 0 });

  const pushHistory = useCallback(() => {
    past.current.push(snapshot());
    if (past.current.length > HISTORY_LIMIT) past.current.shift();
    future.current = [];
    setHistory({ undo: past.current.length, redo: 0 });
  }, [snapshot]);

  const restore = useCallback((snap: Snapshot) => {
    setPagesRaw(snap.pages);
    setAnnotationsRaw(snap.annotations);
    setCurrentPageIdRaw(snap.currentPageId);
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(snapshot());
    restore(prev);
    setSelectedId(null);
    setEditingTextId(null);
    setDirty(true);
    setHistory({ undo: past.current.length, redo: future.current.length });
  }, [restore, snapshot]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(snapshot());
    restore(next);
    setSelectedId(null);
    setEditingTextId(null);
    setDirty(true);
    setHistory({ undo: past.current.length, redo: future.current.length });
  }, [restore, snapshot]);

  /* ---------------------------------------------------------- mutation API */

  const setPages: React.Dispatch<React.SetStateAction<PageMeta[]>> = useCallback((action) => {
    setPagesRaw((prev) => {
      const next = typeof action === "function" ? (action as (p: PageMeta[]) => PageMeta[])(prev) : action;
      const cur = stateRef.current.currentPageId;
      if (next.length && !next.some((p) => p.id === cur)) {
        const oldIdx = Math.max(0, prev.findIndex((p) => p.id === cur));
        setCurrentPageIdRaw(next[Math.min(oldIdx, next.length - 1)]?.id ?? next[0].id);
      }
      if (!next.length) setCurrentPageIdRaw(null);
      return next;
    });
    setDirty(true);
  }, []);

  const setAnnotations: React.Dispatch<React.SetStateAction<Record<string, Annotation[]>>> = useCallback((action) => {
    setAnnotationsRaw(action);
    setDirty(true);
  }, []);

  const setCurrentPageId = useCallback((id: string) => {
    setCurrentPageIdRaw(id);
    setSelectedId(null);
    setEditingTextId(null);
  }, []);

  const goTo = useCallback(
    (index: number) => {
      const p = pages[Math.max(0, Math.min(pages.length - 1, index))];
      if (p) setCurrentPageId(p.id);
    },
    [pages, setCurrentPageId]
  );

  const addAnnotation = useCallback(
    (a: Annotation, options?: { undoable?: boolean }) => {
      if (options?.undoable !== false) pushHistory();
      setAnnotationsRaw((prev) => ({ ...prev, [a.pageId]: [...(prev[a.pageId] ?? []), a] }));
      setDirty(true);
    },
    [pushHistory]
  );

  const updateAnnotation = useCallback((id: string, patch: Partial<Annotation>) => {
    setAnnotationsRaw((prev) => {
      const next: Record<string, Annotation[]> = {};
      for (const [pageId, list] of Object.entries(prev)) {
        next[pageId] = list.map((a) => (a.id === id ? ({ ...a, ...patch } as Annotation) : a));
      }
      return next;
    });
    setDirty(true);
  }, []);

  const removeAnnotation = useCallback(
    (id: string) => {
      pushHistory();
      setAnnotationsRaw((prev) => {
        const next: Record<string, Annotation[]> = {};
        for (const [pageId, list] of Object.entries(prev)) next[pageId] = list.filter((a) => a.id !== id);
        return next;
      });
      setSelectedId((s) => (s === id ? null : s));
      setEditingTextId((s) => (s === id ? null : s));
      setDirty(true);
    },
    [pushHistory]
  );

  const duplicateAnnotation = useCallback(
    (id: string) => {
      let source: Annotation | null = null;
      for (const list of Object.values(stateRef.current.annotations)) {
        const hit = list.find((a) => a.id === id);
        if (hit) source = hit;
      }
      if (!source) return;
      const copy = structuredClone(source) as Annotation;
      copy.id = uid("an");
      if (copy.type === "draw") {
        copy.points = copy.points.map((p) => ({ x: p.x + 14, y: p.y + 14 }));
        copy.rect = { ...copy.rect, x: copy.rect.x + 14, y: copy.rect.y + 14 };
      } else {
        copy.rect = { ...copy.rect, x: copy.rect.x + 14, y: copy.rect.y + 14 };
      }
      addAnnotation(copy);
      setSelectedId(copy.id);
    },
    [addAnnotation]
  );

  const clearPage = useCallback(
    (pageId: string) => {
      pushHistory();
      setAnnotationsRaw((prev) => ({ ...prev, [pageId]: [] }));
      setDirty(true);
    },
    [pushHistory]
  );

  /** Replace an OCR word: erase its pixels + drop an editable text box in place. */
  const replaceOcrWord = useCallback(
    (pageId: string, word: OcrWord, replacement: string) => {
      pushHistory();
      setPagesRaw((prev) =>
        prev.map((p) => {
          if (p.id !== pageId || !p.ocr) return p;
          const words = p.ocr.words.map((w) =>
            w === word || (w.x === word.x && w.y === word.y && w.text === word.text) ? { ...w, conf: -1 } : w
          );
          return { ...p, ocr: { ...p.ocr, words } };
        })
      );
      /*
       * The replacement occupies the word it replaces.
       *
       * The old box was `max(word.w + 24, len * h * 0.62 + 16)` — a guess that
       * was usually wider than the original word, so the new text stuck out
       * past where the old text ended. It also sat 18% higher and 45% taller
       * than the glyphs, and used a fixed near-black Helvetica regardless of
       * what the page actually looked like. Now the box is the word's own
       * box and the renderer fits the text to it, sampling the page for ink
       * colour (see lib/patch.ts).
       */
      const ann: Annotation = {
        id: uid("an"),
        pageId,
        type: "text",
        rect: {
          x: Math.max(0, word.x - 0.5),
          y: word.y,
          w: word.w + 1,
          h: word.h,
        },
        text: replacement,
        // A starting point only — the renderer sizes to the glyphs it measures
        // and shrinks further if the replacement is longer than the original.
        fontSize: Math.max(4, word.h),
        fontKey: "helvetica",
        color: "#111111",
        align: "left",
        opacity: 1,
        lineHeight: 1.15,
      };
      setAnnotationsRaw((prev) => ({ ...prev, [pageId]: [...(prev[pageId] ?? []), ann] }));
      setDirty(true);
    },
    [pushHistory]
  );

  /** Delete an OCR word: erase the pixels and forget its text. */
  const deleteOcrWord = useCallback(
    (pageId: string, word: OcrWord) => {
      pushHistory();
      setPagesRaw((prev) =>
        prev.map((p) => {
          if (p.id !== pageId || !p.ocr) return p;
          return {
            ...p,
            ocr: {
              ...p.ocr,
              words: p.ocr.words.map((w) =>
                w.x === word.x && w.y === word.y && w.text === word.text ? { ...w, conf: -1 } : w
              ),
            },
          };
        })
      );
      setDirty(true);
    },
    [pushHistory]
  );

  const setPageOcr = useCallback((pageId: string, ocr: OcrResult | undefined, state?: PageMeta["ocrState"]) => {
    setPagesRaw((prev) =>
      prev.map((p) => (p.id === pageId ? { ...p, ocr: ocr ?? p.ocr, ocrState: state ?? p.ocrState } : p))
    );
    setDirty(true);
  }, []);

  const rotatePage = useCallback(
    (pageId: string, dir: 1 | -1) => {
      pushHistory();
      setPagesRaw((prev) =>
        prev.map((p) =>
          p.id === pageId
            ? {
                ...p,
                rotation: ((((p.rotation + dir * 90) % 360) + 360) % 360) as Rotation,
                thumb: undefined,
                ocr: undefined,
                ocrState: "idle",
              }
            : p
        )
      );
      setDirty(true);
    },
    [pushHistory]
  );

  const rotateAll = useCallback(
    (dir: 1 | -1) => {
      pushHistory();
      setPagesRaw((prev) =>
        prev.map((p) => ({
          ...p,
          rotation: ((((p.rotation + dir * 90) % 360) + 360) % 360) as Rotation,
          thumb: undefined,
          ocr: undefined,
          ocrState: "idle",
        }))
      );
      setDirty(true);
    },
    [pushHistory]
  );

  const markSaved = useCallback(() => setDirty(false), []);

  const reset = useCallback(() => {
    past.current = [];
    future.current = [];
    setPagesRaw([]);
    setAnnotationsRaw({});
    setCurrentPageIdRaw(null);
    setSelectedId(null);
    setEditingTextId(null);
    setDocName("scanned-document");
    setDirty(false);
    setHistory({ undo: 0, redo: 0 });
  }, []);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirty || !stateRef.current.pages.length) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const value: StoreValue = {
    pages,
    setPages,
    annotations,
    setAnnotations,
    currentPageId,
    currentIndex,
    currentPage,
    setCurrentPageId,
    goTo,
    tool,
    setTool,
    tools,
    setTools,
    selectedId,
    setSelectedId,
    editingTextId,
    setEditingTextId,
    addAnnotation,
    updateAnnotation,
    removeAnnotation,
    duplicateAnnotation,
    clearPage,
    replaceOcrWord,
    deleteOcrWord,
    setPageOcr,
    rotatePage,
    rotateAll,
    undo,
    redo,
    canUndo: history.undo > 0,
    canRedo: history.redo > 0,
    docName,
    setDocName,
    dirty,
    markSaved,
    reset,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore must be used inside <StoreProvider>");
  return ctx;
}
