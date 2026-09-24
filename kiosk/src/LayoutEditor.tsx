import { useRef, useState } from "react";
import { agent, agentUrl, PrintSize, Slot, Template } from "./agent";

/** Paper choices. A landscape 4R layout is turned onto the sheet by booth-agent at print time. */
const PAPERS = [
  { key: "4r-landscape", label: "4R landscape", printSize: "4x6", w: 1800, h: 1200 },
  { key: "4r-portrait", label: "4R portrait", printSize: "4x6", w: 1200, h: 1800 },
  { key: "strip", label: "2×6 strips", printSize: "2x6-strip", w: 600, h: 1800 },
] as const;

const SNAP = 10;
const MIN_SLOT = 60;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

const paperOf = (t: Pick<Template, "printSize" | "cellWidthPx" | "cellHeightPx">) =>
  PAPERS.find((p) => p.printSize === t.printSize && p.w === t.cellWidthPx && p.h === t.cellHeightPx) ?? PAPERS[0];

/** Small picture of a layout's photo slots, for the Settings list. */
export function LayoutThumb({ t, height }: { t: Template; height: number }) {
  return (
    <svg height={height} viewBox={`0 0 ${t.cellWidthPx} ${t.cellHeightPx}`} className="layout-thumb" aria-hidden="true">
      <rect width={t.cellWidthPx} height={t.cellHeightPx} fill="#FBF8F3" />
      {t.photoSlots.map((s, i) => (
        <g key={i}>
          <rect x={s.x} y={s.y} width={s.width} height={s.height} fill="#3A3342" />
          <text x={s.x + s.width / 2} y={s.y + s.height / 2} fill="#F5EFE6" fontSize={Math.min(s.width, s.height) / 2.5}
            fontWeight="800" textAnchor="middle" dominantBaseline="central">{i + 1}</text>
        </g>
      ))}
    </svg>
  );
}

export function newTemplate(): Template {
  return {
    id: "",
    name: "",
    printSize: "4x6",
    cellWidthPx: 1800,
    cellHeightPx: 1200,
    photoSlots: [
      { x: 60, y: 60, width: 810, height: 540 },
      { x: 930, y: 60, width: 810, height: 540 },
      { x: 60, y: 620, width: 810, height: 540 },
      { x: 930, y: 620, width: 810, height: 540 },
    ],
    overlayFile: null,
  };
}

function slugFor(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "layout";
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

type Drag = { index: number; mode: "move" | "resize"; startX: number; startY: number; start: Slot; pxPerCell: number };

export default function LayoutEditor({ initial, takenIds, inUseId, onClose }: {
  initial: Template; takenIds: string[]; inUseId: string; onClose: (changed: boolean) => void;
}) {
  const [t, setT] = useState<Template>(initial);
  const [selected, setSelected] = useState(0);
  const [lock, setLock] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [overlayVer, setOverlayVer] = useState(0);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const isNew = initial.id === "";
  const paper = paperOf(t);

  // Canvas is drawn at a fixed on-stage size; cell pixels map onto it.
  const view = Math.min(1040 / t.cellWidthPx, 900 / t.cellHeightPx);

  const setSlot = (i: number, slot: Slot) =>
    setT((cur) => ({ ...cur, photoSlots: cur.photoSlots.map((s, j) => (j === i ? slot : s)) }));

  function startDrag(e: React.PointerEvent, index: number, mode: Drag["mode"]) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    // Measured on screen, so it already includes the stage's own scale-to-fit.
    const pxPerCell = canvas.current!.getBoundingClientRect().width / t.cellWidthPx;
    drag.current = { index, mode, startX: e.clientX, startY: e.clientY, start: t.photoSlots[index]!, pxPerCell };
    setSelected(index);
  }

  function moveDrag(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.pxPerCell;
    const dy = (e.clientY - d.startY) / d.pxPerCell;
    const s = d.start;
    if (d.mode === "move") {
      setSlot(d.index, {
        ...s,
        x: clamp(snap(s.x + dx), 0, t.cellWidthPx - s.width),
        y: clamp(snap(s.y + dy), 0, t.cellHeightPx - s.height),
      });
    } else {
      let width = clamp(snap(s.width + dx), MIN_SLOT, t.cellWidthPx - s.x);
      let height = lock ? Math.round((width * 2) / 3) : clamp(snap(s.height + dy), MIN_SLOT, t.cellHeightPx - s.y);
      if (s.y + height > t.cellHeightPx) {
        // Locked ratio ran off the bottom: shrink both to fit.
        height = t.cellHeightPx - s.y;
        width = Math.round((height * 3) / 2);
      }
      setSlot(d.index, { ...s, width, height });
    }
  }

  function changePaper(key: string) {
    const p = PAPERS.find((x) => x.key === key)!;
    const sx = p.w / t.cellWidthPx;
    const sy = p.h / t.cellHeightPx;
    setT({
      ...t,
      printSize: p.printSize as PrintSize,
      cellWidthPx: p.w,
      cellHeightPx: p.h,
      photoSlots: t.photoSlots.map((s) => {
        const width = Math.max(MIN_SLOT, snap(s.width * sx));
        const height = Math.max(MIN_SLOT, snap(s.height * sy));
        return { x: clamp(snap(s.x * sx), 0, p.w - width), y: clamp(snap(s.y * sy), 0, p.h - height), width, height };
      }),
    });
  }

  function addSlot() {
    if (t.photoSlots.length >= 12) return;
    const width = snap(Math.min(t.cellWidthPx, t.cellHeightPx * 1.5) / 3);
    const slot = { x: 30, y: 30, width, height: Math.round((width * 2) / 3) };
    setT({ ...t, photoSlots: [...t.photoSlots, slot] });
    setSelected(t.photoSlots.length);
  }

  function removeSlot() {
    if (t.photoSlots.length <= 1) return;
    setT({ ...t, photoSlots: t.photoSlots.filter((_, i) => i !== selected) });
    setSelected(0);
  }

  /** Saves and returns the stored template (a new layout gets its id here). */
  async function save(): Promise<Template | null> {
    const name = (t.name ?? "").trim();
    if (!name) {
      setError("Give the layout a name first.");
      return null;
    }
    setBusy(true);
    setError("");
    try {
      const id = isNew && !t.id ? slugFor(name, takenIds) : t.id;
      const saved = await agent.saveTemplate({ ...t, id, name });
      setT(saved);
      return saved;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function uploadOverlay(file: File | undefined) {
    if (!file) return;
    // Save first: the upload returns the stored layout, which would otherwise drop unsaved edits.
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    try {
      setT(await agent.uploadOverlay(saved.id, file));
      setOverlayVer((v) => v + 1);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await agent.deleteTemplate(t.id);
      onClose(true);
    } catch (e) {
      setError((e as Error).message);
      setConfirmDelete(false);
    }
  }

  return (
    <div className="editor">
      <div
        ref={canvas}
        className="editor-canvas"
        style={{ width: t.cellWidthPx * view, height: t.cellHeightPx * view }}
        onPointerMove={moveDrag}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        {t.photoSlots.map((s, i) => (
          <div
            key={i}
            className={`editor-slot ${i === selected ? "selected" : ""}`}
            style={{ left: s.x * view, top: s.y * view, width: s.width * view, height: s.height * view }}
            onPointerDown={(e) => startDrag(e, i, "move")}
          >
            <span>{i + 1}</span>
            {i === selected && (
              <div className="editor-handle" aria-label="Resize" onPointerDown={(e) => startDrag(e, i, "resize")} />
            )}
          </div>
        ))}
        {t.overlayFile && t.id && (
          <img className="editor-overlay" src={agentUrl(`/templates/${t.id}/overlay?v=${overlayVer}`)} alt="" />
        )}
      </div>

      <div className="editor-side">
        <label className="field">
          <span>Name</span>
          <input value={t.name ?? ""} maxLength={80} onChange={(e) => setT({ ...t, name: e.target.value })}
            placeholder="e.g. Wedding 4-up" />
        </label>

        <div className="field">
          <span>Paper</span>
          <div className="seg">
            {PAPERS.map((p) => (
              <button key={p.key} type="button" className={p.key === paper.key ? "on" : ""} onClick={() => changePaper(p.key)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>Photos: {t.photoSlots.length} (one shot each)</span>
          <div className="row gap-16">
            <button type="button" className="btn outline sm" onClick={addSlot} disabled={t.photoSlots.length >= 12}>Add photo</button>
            <button type="button" className="btn outline sm" onClick={removeSlot} disabled={t.photoSlots.length <= 1}>
              Remove #{selected + 1}
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} />
            Keep 3:2 camera shape when resizing
          </label>
        </div>

        <div className="field">
          <span>Overlay (PNG with transparent holes for the photos)</span>
          <div className="row gap-16">
            <label className="btn outline sm file-btn">
              {t.overlayFile ? "Replace overlay" : "Upload overlay"}
              {/* Clear the value so re-picking the same (edited) file still fires onChange. */}
              <input type="file" accept="image/png"
                onChange={(e) => { uploadOverlay(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            {t.overlayFile && (
              <button type="button" className="btn outline sm" onClick={() => setT({ ...t, overlayFile: null })}>Remove</button>
            )}
          </div>
        </div>

        {error && <div className="banner error fs-24">{error}</div>}

        <div className="row gap-16 editor-actions">
          <button type="button" className="btn primary sm" disabled={busy}
            onClick={async () => { if (await save()) onClose(true); }}>
            Save
          </button>
          {/* An overlay upload already saved the layout, so the list needs a refresh even on Cancel. */}
          <button type="button" className="btn outline sm" onClick={() => onClose(t.id !== initial.id || overlayVer > 0)}>
            Cancel
          </button>
          {!isNew && t.id !== inUseId && (
            <button type="button" className="btn outline sm danger" onClick={remove}>
              {confirmDelete ? "Tap again to delete" : "Delete"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
