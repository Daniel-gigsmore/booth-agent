// Layout editing as plain functions over Template, so it can be tested
// without a browser. The editor (LayoutEditor.tsx) only wires these to the UI.
import type { LayoutElement, PhotoElement, Template } from "./agent";

/** Paper choices. A landscape 4R layout is turned onto the sheet by booth-agent at print time. */
export const PAPERS = [
  { key: "4r-landscape", label: "4R landscape", printSize: "4x6", w: 1800, h: 1200 },
  { key: "4r-portrait", label: "4R portrait", printSize: "4x6", w: 1200, h: 1800 },
  { key: "strip", label: "2×6 strips", printSize: "2x6-strip", w: 600, h: 1800 },
] as const;

export const SNAP = 10;
export const MIN_SIZE = 20;
/** booth-agent rejects boxes larger than this. */
export const MAX_SIZE = 3600;
export const MAX_SHOTS = 12;
export const MAX_ELEMENTS = 40;
export const VARIABLES = ["{event}", "{date}", "{time}", "{code}"] as const;

export const snap = (v: number) => Math.round(v / SNAP) * SNAP;
export const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const side = (v: number) => clamp(snap(v), MIN_SIZE, MAX_SIZE);

export const paperOf = (t: Pick<Template, "printSize" | "cellWidthPx" | "cellHeightPx">) =>
  PAPERS.find((p) => p.printSize === t.printSize && p.w === t.cellWidthPx && p.h === t.cellHeightPx) ?? PAPERS[0];

/** How many photos a guest takes: the highest shot number + 1. */
export function shotCount(t: Pick<Template, "elements">): number {
  return Math.max(0, ...t.elements.map((e) => (e.type === "photo" ? e.shot + 1 : 0)));
}

const box = (id: string, x: number, y: number, width: number, height: number) => ({
  id, x, y, width, height, rotation: 0, hidden: false,
});

/** A 4R landscape 2x2 grid with even margins: 60 px across, 40 px down. */
export function newTemplate(): Template {
  const photo = (shot: number, x: number, y: number): PhotoElement => ({
    ...box(`photo-${shot + 1}`, x, y, 810, 540), type: "photo", shot,
  });
  return {
    id: "", name: "", printSize: "4x6", cellWidthPx: 1800, cellHeightPx: 1200, background: "#ffffff",
    elements: [photo(0, 60, 40), photo(1, 930, 40), photo(2, 60, 620), photo(3, 930, 620)],
  };
}

/** An element id the layout doesn't use yet: `<prefix>-1`, `<prefix>-2`, … */
export function newId(t: Template, prefix: string): string {
  const taken = new Set(t.elements.map((e) => e.id));
  let n = 1;
  while (taken.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

export type AddKind = "photo" | "text" | "rect";

export function canAdd(t: Template, kind: AddKind | "image"): boolean {
  if (t.elements.length >= MAX_ELEMENTS) return false;
  return kind !== "photo" || shotCount(t) < MAX_SHOTS;
}

const withElement = (t: Template, el: LayoutElement) => ({ template: { ...t, elements: [...t.elements, el] }, id: el.id });

/** Adds a new element on top. A photo takes the next shot. */
export function addElement(t: Template, kind: AddKind): { template: Template; id: string } {
  const W = t.cellWidthPx;
  const H = t.cellHeightPx;
  if (kind === "photo") {
    const width = snap(Math.min(W, H * 1.5) / 3);
    return withElement(t, { ...box(newId(t, "photo"), 30, 30, width, Math.round((width * 2) / 3)), type: "photo", shot: shotCount(t) });
  }
  if (kind === "text") {
    return withElement(t, {
      ...box(newId(t, "text"), 60, snap(H / 2 - 60), W - 120, 120),
      type: "text", text: "{event}", font: "Manrope", size: 80, color: "#222222", align: "center", bold: true,
    });
  }
  return withElement(t, { ...box(newId(t, "shape"), 30, 30, snap(W / 3), snap(H / 6)), type: "rect", fill: "#f26b3a", radius: 0, opacity: 1 });
}

/** Adds an uploaded image on top, a third of the cell wide or tall, keeping its shape. */
export function addImage(t: Template, file: string, naturalWidth: number, naturalHeight: number): { template: Template; id: string } {
  const scale = Math.min(t.cellWidthPx / 3 / naturalWidth, t.cellHeightPx / 3 / naturalHeight);
  const width = clamp(Math.round(naturalWidth * scale), MIN_SIZE, MAX_SIZE);
  const height = clamp(Math.round(naturalHeight * scale), MIN_SIZE, MAX_SIZE);
  return withElement(t, { ...box(newId(t, "image"), 30, 30, width, height), type: "image", file });
}

/**
 * Renumbers shots 0..n-1, keeping their order, so re-assigning or deleting a
 * photo never leaves a gap (booth-agent rejects gaps).
 */
export function compactShots(elements: LayoutElement[]): LayoutElement[] {
  const used = [...new Set(elements.flatMap((e) => (e.type === "photo" ? [e.shot] : [])))].sort((a, b) => a - b);
  return elements.map((e) => (e.type === "photo" ? { ...e, shot: used.indexOf(e.shot) } : e));
}

export function updateElement(t: Template, id: string, patch: Partial<LayoutElement>): Template {
  const elements = t.elements.map((e) => (e.id === id ? ({ ...e, ...patch } as LayoutElement) : e));
  return { ...t, elements: "shot" in patch ? compactShots(elements) : elements };
}

/** The last photo can't go: a layout needs at least one. */
export function canRemove(t: Template, id: string): boolean {
  const el = t.elements.find((e) => e.id === id);
  return !!el && (el.type !== "photo" || t.elements.filter((e) => e.type === "photo").length > 1);
}

export function removeElement(t: Template, id: string): Template {
  if (!canRemove(t, id)) return t;
  return { ...t, elements: compactShots(t.elements.filter((e) => e.id !== id)) };
}

/** dir 1 = one layer up (drawn later, on top); -1 = one layer down. */
export function moveLayer(t: Template, id: string, dir: 1 | -1): Template {
  const i = t.elements.findIndex((e) => e.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= t.elements.length) return t;
  const elements = [...t.elements];
  [elements[i], elements[j]] = [elements[j]!, elements[i]!];
  return { ...t, elements };
}

export type Edge = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/** Lines the (unrotated) box up with an edge or the centre of the paper. */
export function alignPatch(el: LayoutElement, edge: Edge, t: Template): { x: number } | { y: number } {
  const W = t.cellWidthPx;
  const H = t.cellHeightPx;
  switch (edge) {
    case "left": return { x: 0 };
    case "hcenter": return { x: Math.round((W - el.width) / 2) };
    case "right": return { x: W - el.width };
    case "top": return { y: 0 };
    case "vcenter": return { y: Math.round((H - el.height) / 2) };
    case "bottom": return { y: H - el.height };
  }
}

/** Covers the whole paper, e.g. for a frame or a background band. */
export function fillPatch(t: Template) {
  return { x: 0, y: 0, width: t.cellWidthPx, height: t.cellHeightPx, rotation: 0 };
}

type Rect = { x: number; y: number; width: number; height: number };

/** Where a dragged box lands: snapped, and never dragged fully off the paper. */
export function movedBox(start: Rect, dx: number, dy: number, t: Template): { x: number; y: number } {
  return {
    x: clamp(snap(start.x + dx), MIN_SIZE - start.width, t.cellWidthPx - MIN_SIZE),
    y: clamp(snap(start.y + dy), MIN_SIZE - start.height, t.cellHeightPx - MIN_SIZE),
  };
}

/** Size after dragging the corner handle. Locked keeps the shape the box had when the drag began. */
export function resizedBox(start: Pick<Rect, "width" | "height">, dx: number, dy: number, lock: boolean) {
  const width = side(start.width + dx);
  const height = lock ? clamp(Math.round((width * start.height) / start.width), MIN_SIZE, MAX_SIZE) : side(start.height + dy);
  return { width, height };
}

/** One side typed into a number field; locked scales the other side to keep the shape. */
export function sizePatch(el: Pick<Rect, "width" | "height">, key: "width" | "height", value: number, lock: boolean) {
  const v = clamp(Math.round(value), MIN_SIZE, MAX_SIZE);
  if (!lock) return { [key]: v } as { width: number } | { height: number };
  return key === "width"
    ? { width: v, height: clamp(Math.round((v * el.height) / el.width), MIN_SIZE, MAX_SIZE) }
    : { height: v, width: clamp(Math.round((v * el.width) / el.height), MIN_SIZE, MAX_SIZE) };
}

export function normalizeAngle(deg: number): number {
  return ((((Math.round(deg) + 180) % 360) + 360) % 360) - 180;
}

/**
 * Switches paper, scaling every element (and text size) to the new cell.
 * Photos crop to fill their box, so they scale x/width and y/height
 * independently, stretching to keep the grid filling the page. Images,
 * text and shapes keep their proportions: position still scales per axis,
 * but width/height scale together by the smaller of the two factors.
 */
export function changePaper(t: Template, key: string): Template {
  const p = PAPERS.find((x) => x.key === key) ?? PAPERS[0];
  if (p.key === paperOf(t).key) return t;
  const sx = p.w / t.cellWidthPx;
  const sy = p.h / t.cellHeightPx;
  const s = Math.min(sx, sy);
  return {
    ...t,
    printSize: p.printSize,
    cellWidthPx: p.w,
    cellHeightPx: p.h,
    elements: t.elements.map((e) => {
      const wf = e.type === "photo" ? sx : s;
      const hf = e.type === "photo" ? sy : s;
      const scaled = { ...e, x: snap(e.x * sx), y: snap(e.y * sy), width: side(e.width * wf), height: side(e.height * hf) };
      return scaled.type === "text" ? { ...scaled, size: clamp(Math.round(scaled.size * s), 8, 600) } : scaled;
    }),
  };
}

// Spelled out: some browsers' en-GB short month for September is "Sept".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Text as the editor shows it: variables filled in the way a print made now would have them. */
export function sampleText(text: string, eventName: string, now: Date = new Date()): string {
  const vars = {
    event: eventName || "Event name",
    date: `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    code: "a1b2c3d4",
  };
  return text.replace(/\{(event|date|time|code)\}/g, (_m, k: keyof typeof vars) => vars[k]);
}

/**
 * Just the fields booth-agent stores. A body carrying the pre-elements
 * photoSlots field would be treated as old-format, so never send extras.
 */
export function templateBody(t: Template): Template {
  const { id, name, printSize, cellWidthPx, cellHeightPx, background, elements } = t;
  return { id, name, printSize, cellWidthPx, cellHeightPx, background, elements };
}

export function elementLabel(el: LayoutElement): string {
  switch (el.type) {
    case "photo": return `Photo ${el.shot + 1}`;
    case "image": return "Image";
    case "rect": return "Shape";
    case "text": {
      const s = el.text.trim() || "(empty)";
      return `Text: ${s.length > 18 ? `${s.slice(0, 18)}…` : s}`;
    }
  }
}

export interface History { past: Template[]; present: Template; future: Template[] }
export const HISTORY_LIMIT = 50;

export const historyOf = (t: Template): History => ({ past: [], present: t, future: [] });

/** A new undo step; clears redo. */
export function historyCommit(h: History, next: Template): History {
  if (next === h.present) return h;
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [] };
}

/** Changes the layout without an undo step (mid-drag, or a save's response). */
export function historyReplace(h: History, next: Template): History {
  return { ...h, present: next };
}

/** Records a finished gesture (a drag) as one undo step, back to where it began. */
export function historyCommitFrom(h: History, before: Template): History {
  if (h.present === before) return h;
  return { past: [...h.past, before].slice(-HISTORY_LIMIT), present: h.present, future: [] };
}

export function historyUndo(h: History): History {
  const prev = h.past[h.past.length - 1];
  return prev ? { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] } : h;
}

export function historyRedo(h: History): History {
  const next = h.future[0];
  return next ? { past: [...h.past, h.present], present: next, future: h.future.slice(1) } : h;
}
