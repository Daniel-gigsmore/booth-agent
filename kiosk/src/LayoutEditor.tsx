import { useRef, useState } from "react";
import { agent, agentUrl, config, LayoutElement, Template } from "./agent";
import { AddPanel, LayersPanel, PropsPanel } from "./EditorPanels";
import { cssFamily, useAgentFonts } from "./fonts";
import { CompositePreview } from "./screens";
import {
  addElement, addImage, AddKind, changePaper, History, historyCommit, historyCommitFrom, historyOf, historyRedo,
  historyReplace, historyUndo, moveLayer, movedBox, removeElement, resizedBox, sampleText, updateElement,
} from "./layout";

/** Small picture of a layout, for the Settings list. */
export function LayoutThumb({ t, height }: { t: Template; height: number }) {
  return (
    <svg height={height} viewBox={`0 0 ${t.cellWidthPx} ${t.cellHeightPx}`} className="layout-thumb" aria-hidden="true">
      <rect width={t.cellWidthPx} height={t.cellHeightPx} fill={t.background} />
      {t.elements.filter((e) => !e.hidden).map((e) => {
        const turn = e.rotation ? `rotate(${e.rotation} ${e.x + e.width / 2} ${e.y + e.height / 2})` : undefined;
        const at = { x: e.x, y: e.y, width: e.width, height: e.height };
        switch (e.type) {
          case "photo":
            return (
              <g key={e.id} transform={turn}>
                <rect {...at} fill="#3A3342" />
                <text x={e.x + e.width / 2} y={e.y + e.height / 2} fill="#F5EFE6" fontSize={Math.min(e.width, e.height) / 2.5}
                  fontWeight="800" textAnchor="middle" dominantBaseline="central">{e.shot + 1}</text>
              </g>
            );
          case "image":
            return <image key={e.id} {...at} transform={turn} preserveAspectRatio="none"
              href={agentUrl(`/templates/${t.id}/assets/${e.file}`)} />;
          case "rect":
            return <rect key={e.id} {...at} transform={turn} fill={e.fill} fillOpacity={e.opacity} rx={e.radius} />;
          case "text":
            // A bar where the text goes; the thumbnail is too small to read.
            return <rect key={e.id} x={e.x} y={e.y + e.height * 0.3} width={e.width} height={e.height * 0.4}
              transform={turn} fill={e.color} fillOpacity={0.5} rx={e.height * 0.1} />;
        }
      })}
    </svg>
  );
}

function slugFor(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "layout";
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

const JUSTIFY = { left: "flex-start", center: "center", right: "flex-end" } as const;

/** One element as the editor draws it, filling its (already positioned and rotated) box. */
function ElementBody({ el, layoutId, view }: { el: LayoutElement; layoutId: string; view: number }) {
  switch (el.type) {
    case "photo":
      return <div className="el-photo" style={{ fontSize: Math.min(el.width, el.height) * view / 2.5 }}>{el.shot + 1}</div>;
    case "image":
      return <img className="el-fill" src={agentUrl(`/templates/${layoutId}/assets/${el.file}`)} alt="" draggable={false} />;
    case "rect":
      return <div className="el-fill" style={{ background: el.fill, opacity: el.opacity, borderRadius: el.radius * view }} />;
    case "text":
      return (
        <div className="el-text" style={{
          justifyContent: JUSTIFY[el.align], textAlign: el.align, color: el.color,
          fontFamily: cssFamily(el.font), fontSize: el.size * view, fontWeight: el.bold ? 700 : 400,
        }}>
          <span>{sampleText(el.text, config.eventName)}</span>
        </div>
      );
  }
}

type Drag = {
  id: string; mode: "move" | "resize"; startX: number; startY: number;
  start: LayoutElement; before: Template; pxPerCell: number;
};

export default function LayoutEditor({ initial, takenIds, inUseId, onClose }: {
  initial: Template; takenIds: string[]; inUseId: string; onClose: (changed: boolean) => void;
}) {
  const [h, setH] = useState<History>(() => historyOf(initial));
  const t = h.present;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lock, setLock] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Saves and uploads write to booth-agent at once, so the list needs a refresh even on Cancel.
  const [wrote, setWrote] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [preview, setPreview] = useState<string | null>(null); // object URL of the rendered sheet
  const [confirmPrint, setConfirmPrint] = useState(false);
  const [printNote, setPrintNote] = useState("");
  const fonts = useAgentFonts();
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  // The saved id lives outside undo history: pre-save snapshots have id "", and
  // undoing past the first save must not make a later save mint a second layout.
  const savedId = useRef(initial.id);
  const isNew = initial.id === "";
  const selected = t.elements.find((e) => e.id === selectedId) ?? null;

  // The canvas gets a fixed area of the stage; cell pixels map onto it.
  const view = Math.min(960 / t.cellWidthPx, 680 / t.cellHeightPx);

  const change = (next: Template) => setH((cur) => historyCommit(cur, next));
  const patch = (id: string, p: Partial<LayoutElement>) => setH((cur) => historyCommit(cur, updateElement(cur.present, id, p)));

  function startDrag(e: React.PointerEvent, el: LayoutElement, mode: Drag["mode"]) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Measured on screen, so it already includes the stage's own scale-to-fit.
    const pxPerCell = canvas.current!.getBoundingClientRect().width / t.cellWidthPx;
    drag.current = { id: el.id, mode, startX: e.clientX, startY: e.clientY, start: el, before: t, pxPerCell };
    setSelectedId(el.id);
  }

  function moveDrag(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.pxPerCell;
    const dy = (e.clientY - d.startY) / d.pxPerCell;
    // Screen-space drag, even for a rotated box: simple, and the number fields give exact control.
    const p = d.mode === "move" ? movedBox(d.start, dx, dy, t) : resizedBox(d.start, dx, dy, lock);
    setH((cur) => historyReplace(cur, updateElement(cur.present, d.id, p)));
  }

  function endDrag() {
    const d = drag.current;
    drag.current = null;
    if (d) setH((cur) => historyCommitFrom(cur, d.before));
  }

  /** Saves and returns the stored layout (a new layout gets its id here). */
  async function save(): Promise<Template | null> {
    const name = (t.name ?? "").trim();
    if (!name) {
      setError("Give the layout a name first.");
      return null;
    }
    setBusy(true);
    setError("");
    try {
      const id = t.id || savedId.current || slugFor(name, takenIds);
      const stored = await agent.saveTemplate({ ...t, id, name });
      setH((cur) => historyReplace(cur, stored));
      setWrote(true);
      savedId.current = stored.id;
      return stored;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** The draft as booth-agent should see it: an unsaved new layout still needs a valid id and a name. */
  const draft = (): Template => ({ ...t, id: t.id || savedId.current || "draft", name: (t.name ?? "").trim() || "Draft" });

  async function openPreview() {
    setBusy(true);
    setError("");
    try {
      setPreview(URL.createObjectURL(await agent.previewLayout(draft())));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function closePreview() {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setConfirmPrint(false);
    setPrintNote("");
  }

  /** Uses a sheet of paper, so it takes a second tap. */
  async function testPrint() {
    if (!confirmPrint) {
      setConfirmPrint(true);
      return;
    }
    setBusy(true);
    try {
      await agent.testPrintLayout(draft());
      setPrintNote("Sent to the printer.");
    } catch (e) {
      setPrintNote((e as Error).message);
    } finally {
      setConfirmPrint(false);
      setBusy(false);
    }
  }

  /** Saves this draft as a separate new layout; the one being edited stays as it was. */
  async function saveAsNew() {
    const name = (t.name ?? "").trim();
    if (!name) {
      setError("Give the layout a name first.");
      return;
    }
    const newName = name === (initial.name ?? "").trim() ? `${name} copy` : name;
    setBusy(true);
    setError("");
    try {
      await agent.copyLayout(savedId.current, t, newName);
      onClose(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function add(kind: AddKind) {
    const r = addElement(t, kind);
    change(r.template);
    setSelectedId(r.id);
  }

  async function addImageFile(file: File | undefined) {
    if (!file) return;
    // Uploads are filed under the layout's id, so a new layout is saved first.
    const base = savedId.current ? t : await save();
    if (!base) return;
    const current = base.id ? base : { ...base, id: savedId.current };
    setBusy(true);
    try {
      const bitmap = await createImageBitmap(file);
      const { width, height } = bitmap;
      bitmap.close();
      const { file: name } = await agent.uploadAsset(current.id, file);
      setWrote(true);
      const r = addImage(current, name, width, height);
      setH((cur) => historyCommit(cur, r.template));
      setSelectedId(r.id);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeLayout() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await agent.deleteTemplate(t.id || savedId.current);
      onClose(true);
    } catch (e) {
      setError((e as Error).message);
      setConfirmDelete(false);
    }
  }

  return (
    <div className="editor">
      <div className="row gap-16 editor-top">
        <input className="text-input grow" value={t.name ?? ""} maxLength={80} placeholder="Layout name, e.g. Wedding 4-up"
          aria-label="Layout name" disabled={busy}
          onChange={(e) => setH((cur) => historyReplace(cur, { ...cur.present, name: e.target.value }))} />
        <button type="button" className="btn outline sm" disabled={busy || !h.past.length} onClick={() => setH(historyUndo)}>Undo</button>
        <button type="button" className="btn outline sm" disabled={busy || !h.future.length} onClick={() => setH(historyRedo)}>Redo</button>
        <button type="button" className="btn outline sm" disabled={busy} onClick={openPreview}>Preview</button>
        <button type="button" className="btn primary sm" disabled={busy} onClick={async () => { if (await save()) onClose(true); }}>
          Save
        </button>
        {savedId.current && (
          <button type="button" className="btn outline sm" disabled={busy} onClick={saveAsNew}>Save as new</button>
        )}
        <button type="button" className="btn outline sm" disabled={busy} onClick={() => onClose(wrote)}>Cancel</button>
        {!isNew && t.id !== inUseId && (
          <button type="button" className="btn outline sm danger" disabled={busy} onClick={removeLayout}>
            {confirmDelete ? "Tap again to delete" : "Delete layout"}
          </button>
        )}
      </div>
      {error && <div className="banner error fs-24">{error}</div>}

      <div className={`editor-body ${busy ? "busy" : ""}`}>
        <AddPanel t={t} busy={busy} onAdd={add} onImage={addImageFile}
          onPaper={(key) => change(changePaper(t, key))} onBackground={(background) => change({ ...t, background })} />

        <div className="editor-stage">
          <div
            ref={canvas}
            className="editor-canvas"
            style={{ width: t.cellWidthPx * view, height: t.cellHeightPx * view, background: t.background }}
            onPointerDown={() => setSelectedId(null)}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {t.elements.map((el) => (
              <div
                key={el.id}
                className={`el ${el.id === selectedId ? "selected" : ""} ${el.hidden ? "hidden-el" : ""}`}
                style={{
                  left: el.x * view, top: el.y * view, width: el.width * view, height: el.height * view,
                  transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
                }}
                onPointerDown={(e) => startDrag(e, el, "move")}
              >
                <ElementBody el={el} layoutId={t.id || savedId.current} view={view} />
                {el.id === selectedId && (
                  <div className="editor-handle" aria-label="Resize" onPointerDown={(e) => startDrag(e, el, "resize")} />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="editor-side">
          <PropsPanel key={selected?.id ?? "none"} el={selected} t={t} fonts={fonts} lock={lock} onLock={setLock}
            onPatch={(p) => selected && patch(selected.id, p)} />
          <LayersPanel t={t} selectedId={selectedId} onSelect={setSelectedId} onPatch={patch}
            onMove={(id, dir) => change(moveLayer(t, id, dir))}
            onDelete={(id) => {
              change(removeElement(t, id));
              if (id === selectedId) setSelectedId(null);
            }} />
        </div>
      </div>

      {preview && (
        <div className="modal">
          <div className="modal-card col gap-24">
            <div className="panel-title">Preview: exactly what prints (sample photos)</div>
            <CompositePreview src={preview} template={t} maxW={1100} maxH={640} />
            {printNote && <div className="muted fs-24">{printNote}</div>}
            <div className="row gap-16">
              <button type="button" className="btn primary sm" disabled={busy} onClick={testPrint}>
                {confirmPrint ? "Tap again: prints 1 sheet" : "Test print"}
              </button>
              <button type="button" className="btn outline sm" disabled={busy} onClick={closePreview}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
