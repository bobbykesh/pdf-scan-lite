"use client";

import { useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Copy,
  GripVertical,
  ImagePlus,
  Layers,
  Plus,
  RotateCw,
  ScanText,
  Trash2,
  X,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { makeBlankPage } from "@/lib/document";
import { useShell } from "./AppShell";
import { IconButton } from "./ui";
import { displaySize } from "@/lib/utils";
import * as Checkbox from "./Checkbox";

function PageThumb({
  index,
  id,
  thumb,
  selected,
  checked,
  ocrBadge,
  aspect,
  onSelect,
  onCheck,
  onDelete,
  onDuplicate,
  onRotate,
}: {
  index: number;
  id: string;
  thumb?: string;
  selected: boolean;
  checked: boolean;
  ocrBadge?: number;
  aspect: number;
  onSelect: () => void;
  onCheck: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onRotate: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 40 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} className="group relative">
      <div
        {...attributes}
        {...listeners}
        onClick={onSelect}
        className={`relative cursor-pointer rounded-lg border p-1.5 transition-all ${
          selected
            ? "border-accent bg-accent/10 shadow-[0_0_0_1px_rgba(109,124,255,.35)]"
            : "border-transparent hover:border-line2 hover:bg-panel2"
        }`}
      >
        <div className="relative overflow-hidden rounded-[3px] bg-white/5" style={{ aspectRatio: String(aspect || 0.707) }}>
          {thumb ? (
             
            <img src={thumb} alt={`Page ${index + 1}`} className="h-full w-full object-contain" draggable={false} />
          ) : (
            <div className="shimmer h-full w-full" />
          )}
          <span className="absolute left-1 top-1 rounded bg-black/65 px-1 py-0.5 text-[9.5px] font-medium text-white backdrop-blur">
            {index + 1}
          </span>
          {ocrBadge ? (
            <span className="absolute right-1 top-1 rounded bg-emerald-500/90 px-1 py-0.5 text-[9px] font-semibold text-black">
              OCR
            </span>
          ) : null}
          <div className="absolute inset-x-0 bottom-0 flex justify-center gap-0.5 bg-gradient-to-t from-black/75 to-transparent p-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRotate();
              }}
              title="Rotate"
              className="grid h-5 w-5 place-items-center rounded bg-white/15 text-white hover:bg-white/30"
            >
              <RotateCw size={11} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate();
              }}
              title="Duplicate"
              className="grid h-5 w-5 place-items-center rounded bg-white/15 text-white hover:bg-white/30"
            >
              <Copy size={11} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              title="Delete"
              className="grid h-5 w-5 place-items-center rounded bg-white/15 text-white hover:bg-red-500/80"
            >
              <Trash2 size={11} />
            </button>
          </div>
        </div>
      </div>
      <div className="absolute -left-0.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <Checkbox.Root checked={checked} onChange={onCheck} />
      </div>
      <div className="absolute -right-1 top-1/2 hidden -translate-y-1/2 cursor-grab text-dim group-hover:block">
        <GripVertical size={13} />
      </div>
    </div>
  );
}

export default function Thumbnails() {
  const store = useStore();
  const shell = useShell();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const ids = useMemo(() => store.pages.map((p) => p.id), [store.pages]);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    store.setPages((prev) => arrayMove(prev, oldIndex, newIndex));
  };

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const removePages = (targets: string[]) => {
    if (!targets.length) return;
    store.setPages((prev) => prev.filter((p) => !targets.includes(p.id)));
    setChecked(new Set());
    shell.toast(`${targets.length} page${targets.length === 1 ? "" : "s"} removed`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-1 border-b border-line px-2.5 py-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
          <Layers size={13} />
          Pages
          <span className="rounded bg-panel3 px-1 py-px text-[10px] text-ink/80">{store.pages.length}</span>
        </div>
        <div className="flex items-center">
          <IconButton
            label={selectMode ? "Done selecting" : "Select pages"}
            active={selectMode}
            className="h-7 w-7"
            onClick={() => {
              setSelectMode((v) => !v);
              setChecked(new Set());
            }}
          >
            {selectMode ? <X size={13} /> : <Checkbox.Icon />}
          </IconButton>
        </div>
      </div>

      {selectMode ? (
        <div className="flex items-center justify-between gap-1 border-b border-line bg-panel2 px-2 py-1.5 text-[11px]">
          <span className="text-muted">{checked.size} selected</span>
          <div className="flex gap-1">
            <button
              className="rounded px-1.5 py-0.5 text-ink/80 hover:bg-panel3"
              onClick={() => setChecked(new Set(ids))}
            >
              All
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-bad hover:bg-bad/15 disabled:opacity-40"
              disabled={!checked.size}
              onClick={() => removePages([...checked])}
            >
              Delete
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-accent hover:bg-accent/15 disabled:opacity-40"
              disabled={!checked.size}
              onClick={() => {
                shell.open("export", { only: [...checked] });
              }}
            >
              Export
            </button>
          </div>
        </div>
      ) : null}

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1.5">
              {store.pages.map((p, i) => {
                const { w, h } = displaySize(p);
                return (
                  <PageThumb
                    key={p.id}
                    id={p.id}
                    index={i}
                    thumb={p.thumb}
                    aspect={w / h}
                    selected={store.currentPageId === p.id}
                    checked={checked.has(p.id)}
                    ocrBadge={p.ocr?.words?.length}
                    onSelect={() => store.setCurrentPageId(p.id)}
                    onCheck={() => {
                      setSelectMode(true);
                      toggle(p.id);
                    }}
                    onDelete={() => removePages([p.id])}
                    onDuplicate={() => {
                      const copy = {
                        ...p,
                        id: `${p.id}_copy_${Math.random().toString(36).slice(2, 6)}`,
                        thumb: p.thumb,
                        ocr: undefined,
                        ocrState: "idle" as const,
                      };
                      store.setPages((prev) => {
                        const idx = prev.findIndex((x) => x.id === p.id);
                        return [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)];
                      });
                    }}
                    onRotate={() => store.rotatePage(p.id, 1)}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>

        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <button
            onClick={() => {
              const blank = makeBlankPage();
              store.setPages((prev) => [...prev, blank]);
              store.setCurrentPageId(blank.id);
            }}
            className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-line2 py-3 text-[10.5px] text-muted transition-colors hover:border-accent/60 hover:text-ink"
          >
            <Plus size={15} />
            Blank
          </button>
          <button
            onClick={() => shell.open("scanner")}
            className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-line2 py-3 text-[10.5px] text-muted transition-colors hover:border-accent/60 hover:text-ink"
          >
            <ScanText size={15} />
            Scan
          </button>
        </div>
      </div>
    </div>
  );
}
