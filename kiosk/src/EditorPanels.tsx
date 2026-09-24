import { useRef, useState } from "react";
import type { BundledFont, LayoutElement, Template, TextElement } from "./agent";
import { cssFamily } from "./fonts";
import {
  AddKind, alignPatch, canAdd, canRemove, clamp, Edge, elementLabel, fillPatch, MAX_SHOTS, normalizeAngle,
  PAPERS, paperOf, shotCount, sizePatch, VARIABLES,
} from "./layout";

type Patch = Partial<LayoutElement>;

const SWATCHES = ["#ffffff", "#fbf8f3", "#222222", "#000000", "#f26b3a", "#ffd23f", "#2e6be6", "#3a7d44"];
const EDGES: [Edge, string][] = [
  ["left", "Left"], ["hcenter", "Centre"], ["right", "Right"], ["top", "Top"], ["vcenter", "Middle"], ["bottom", "Bottom"],
];

export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (c: string) => void }) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="row gap-10 wrap">
        <input type="color" className="color-input" value={value} aria-label={`${label}: pick`} onChange={(e) => onChange(e.target.value)} />
        {SWATCHES.map((c) => (
          <button key={c} type="button" className={`swatch ${c === value.toLowerCase() ? "on" : ""}`}
            style={{ background: c }} aria-label={`${label}: ${c}`} onClick={() => onChange(c)} />
        ))}
      </div>
    </div>
  );
}

/** A number with −/+ buttons (no keyboard on the touchscreen). Typed values apply on blur or Enter. */
function NumberField({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft.trim() !== "" && Number.isFinite(Number(draft))) onChange(Number(draft));
    setDraft(null);
  };
  return (
    <div className="num-field">
      <span>{label}</span>
      <div className="row">
        <button type="button" className="num-btn" aria-label={`${label}: less`} onClick={() => onChange(value - step)}>−</button>
        <input type="number" value={draft ?? value} aria-label={label}
          onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        <button type="button" className="num-btn" aria-label={`${label}: more`} onClick={() => onChange(value + step)}>+</button>
      </div>
    </div>
  );
}

export function AddPanel({ t, busy, onAdd, onImage, onPaper, onBackground }: {
  t: Template; busy: boolean; onAdd: (kind: AddKind) => void; onImage: (file: File | undefined) => void;
  onPaper: (key: string) => void; onBackground: (color: string) => void;
}) {
  const paper = paperOf(t);
  const shots = shotCount(t);
  const imageOk = !busy && canAdd(t, "image");
  return (
    <div className="editor-add">
      <div className="panel-title">Add</div>
      <button type="button" className="add-btn" disabled={!canAdd(t, "photo")} onClick={() => onAdd("photo")}>Photo</button>
      <label className={`add-btn file-btn ${imageOk ? "" : "disabled"}`}>
        Image
        {/* Clear the value so picking the same (edited) file again still fires onChange. */}
        <input type="file" accept="image/png,image/jpeg" disabled={!imageOk}
          onChange={(e) => { onImage(e.target.files?.[0]); e.target.value = ""; }} />
      </label>
      <button type="button" className="add-btn" disabled={!canAdd(t, "text")} onClick={() => onAdd("text")}>Text</button>
      <button type="button" className="add-btn" disabled={!canAdd(t, "rect")} onClick={() => onAdd("rect")}>Shape</button>
      <ColorField label="Background" value={t.background} onChange={onBackground} />
      <div className="field">
        <span>Paper</span>
        <div className="col gap-8">
          {PAPERS.map((p) => (
            <button key={p.key} type="button" className={`seg-btn ${p.key === paper.key ? "on" : ""}`} onClick={() => onPaper(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="muted fs-22">{shots} photo{shots === 1 ? "" : "s"} per guest</div>
    </div>
  );
}

function TextProps({ el, fonts, onPatch }: { el: TextElement; fonts: BundledFont[]; onPatch: (p: Patch) => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  function insert(v: string) {
    const a = area.current;
    const at = a ? a.selectionStart : el.text.length;
    const end = a ? a.selectionEnd : at;
    onPatch({ text: el.text.slice(0, at) + v + el.text.slice(end) });
  }
  return (
    <>
      <div className="field">
        <span>Text</span>
        <textarea ref={area} className="text-input" rows={2} maxLength={500} value={el.text}
          onChange={(e) => onPatch({ text: e.target.value })} />
        <div className="row gap-8 wrap">
          {VARIABLES.map((v) => <button key={v} type="button" className="chip" onClick={() => insert(v)}>{v}</button>)}
        </div>
      </div>
      <div className="field">
        <span>Font</span>
        <select className="text-input" value={el.font} style={{ fontFamily: cssFamily(el.font) }}
          onChange={(e) => onPatch({ font: e.target.value })}>
          {fonts.map((f) => <option key={f.family} value={f.family}>{f.family}</option>)}
          {!fonts.some((f) => f.family === el.font) && <option value={el.font}>{el.font}</option>}
        </select>
      </div>
      <div className="grid-2">
        <NumberField label="Size" value={el.size} step={4} onChange={(v) => onPatch({ size: clamp(Math.round(v), 8, 600) })} />
        <label className="check">
          <input type="checkbox" checked={el.bold} onChange={(e) => onPatch({ bold: e.target.checked })} />
          Bold
        </label>
      </div>
      <div className="seg self-start">
        {(["left", "center", "right"] as const).map((a) => (
          <button key={a} type="button" className={el.align === a ? "on" : ""} onClick={() => onPatch({ align: a })}>
            {a === "left" ? "Left" : a === "center" ? "Centre" : "Right"}
          </button>
        ))}
      </div>
      <ColorField label="Colour" value={el.color} onChange={(color) => onPatch({ color })} />
    </>
  );
}

export function PropsPanel({ el, t, fonts, lock, onLock, onPatch }: {
  el: LayoutElement | null; t: Template; fonts: BundledFont[]; lock: boolean;
  onLock: (v: boolean) => void; onPatch: (p: Patch) => void;
}) {
  if (!el) {
    return (
      <div className="panel col gap-10">
        <div className="panel-title">Selected</div>
        <div className="muted fs-22">Tap something on the layout or in Layers, or add something new.</div>
      </div>
    );
  }
  const shots = shotCount(t);
  return (
    <div className="panel col gap-16">
      <div className="panel-title">{elementLabel(el)}</div>
      <div className="grid-2">
        <NumberField label="X" value={el.x} step={10} onChange={(v) => onPatch({ x: Math.round(v) })} />
        <NumberField label="Y" value={el.y} step={10} onChange={(v) => onPatch({ y: Math.round(v) })} />
        <NumberField label="W" value={el.width} step={10} onChange={(v) => onPatch(sizePatch(el, "width", v, lock))} />
        <NumberField label="H" value={el.height} step={10} onChange={(v) => onPatch(sizePatch(el, "height", v, lock))} />
        <NumberField label="Rotate°" value={el.rotation} step={15} onChange={(v) => onPatch({ rotation: normalizeAngle(v) })} />
        <label className="check">
          <input type="checkbox" checked={lock} onChange={(e) => onLock(e.target.checked)} />
          Keep aspect ratio
        </label>
      </div>
      <div className="row gap-8 wrap">
        {EDGES.map(([edge, label]) => (
          <button key={edge} type="button" className="btn outline xs" onClick={() => onPatch(alignPatch(el, edge, t))}>{label}</button>
        ))}
        <button type="button" className="btn outline xs" onClick={() => onPatch(fillPatch(t))}>Fill paper</button>
      </div>
      {el.type === "photo" && (
        <div className="field">
          <span>Photo number</span>
          <div className="row gap-8 wrap">
            {Array.from({ length: Math.min(shots + 1, MAX_SHOTS) }, (_, i) => (
              <button key={i} type="button" className={`seg-btn ${el.shot === i ? "on" : ""}`} onClick={() => onPatch({ shot: i })}>
                {i + 1}
              </button>
            ))}
          </div>
        </div>
      )}
      {el.type === "text" && <TextProps el={el} fonts={fonts} onPatch={onPatch} />}
      {el.type === "rect" && (
        <>
          <ColorField label="Fill" value={el.fill} onChange={(fill) => onPatch({ fill })} />
          <div className="grid-2">
            <NumberField label="Corner" value={el.radius} step={10} onChange={(v) => onPatch({ radius: Math.max(0, Math.round(v)) })} />
            <NumberField label="Opacity %" value={Math.round(el.opacity * 100)} step={10}
              onChange={(v) => onPatch({ opacity: clamp(Math.round(v), 0, 100) / 100 })} />
          </div>
        </>
      )}
    </div>
  );
}

export function LayersPanel({ t, selectedId, onSelect, onPatch, onMove, onDelete }: {
  t: Template; selectedId: string | null; onSelect: (id: string) => void;
  onPatch: (id: string, p: Patch) => void; onMove: (id: string, dir: 1 | -1) => void; onDelete: (id: string) => void;
}) {
  const top = t.elements.length - 1;
  return (
    <div className="panel col gap-6">
      <div className="panel-title">Layers <span className="muted fs-22">top first</span></div>
      {[...t.elements].reverse().map((el) => {
        const i = t.elements.indexOf(el);
        return (
          <div key={el.id} className={`layer ${el.id === selectedId ? "on" : ""} ${el.hidden ? "muted" : ""}`}>
            <button type="button" className="layer-name" onClick={() => onSelect(el.id)}>{elementLabel(el)}</button>
            <button type="button" className="icon-btn" onClick={() => onPatch(el.id, { hidden: !el.hidden })}>
              {el.hidden ? "Show" : "Hide"}
            </button>
            <button type="button" className="icon-btn" aria-label="Move up" disabled={i === top} onClick={() => onMove(el.id, 1)}>↑</button>
            <button type="button" className="icon-btn" aria-label="Move down" disabled={i === 0} onClick={() => onMove(el.id, -1)}>↓</button>
            <button type="button" className="icon-btn" aria-label="Delete" disabled={!canRemove(t, el.id)} onClick={() => onDelete(el.id)}>✕</button>
          </div>
        );
      })}
    </div>
  );
}
