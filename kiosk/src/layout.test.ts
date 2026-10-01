import { describe, it, expect } from "vitest";
import type { LayoutElement, Template } from "./agent";
import {
  addElement, addImage, alignPatch, alternateCameras, canAdd, canRemove, cameraForShot, changePaper, compactShots,
  elementLabel, fillPatch, historyCommit, historyCommitFrom, historyOf, historyRedo, historyReplace, historyUndo,
  HISTORY_LIMIT, MERGE_MS, MAX_SHOTS, movedBox, moveLayer, newId, newTemplate, normalizeAngle, removeElement,
  resizedBox, sampleText, setShotCamera, shotCount, shotPrompt, sizePatch, templateBody, updateElement, usesLowCamera,
} from "./layout";

const base = { rotation: 0, hidden: false };
const photo = (id: string, shot: number, x = 0): LayoutElement => ({ ...base, id, type: "photo", shot, x, y: 0, width: 300, height: 200 });
const cam = (id: string, shot: number, camera: "high" | "low"): LayoutElement => ({ ...(photo(id, shot) as object), camera } as LayoutElement);
const rect = (id: string): LayoutElement => ({ ...base, id, type: "rect", fill: "#ff0000", radius: 0, opacity: 1, x: 0, y: 0, width: 100, height: 100 });
const image = (id: string, width: number, height: number): LayoutElement => ({ ...base, id, type: "image", file: "f.png", x: 0, y: 0, width, height });
const layout = (elements: LayoutElement[]): Template => ({
  id: "t", name: "T", printSize: "4x6", cellWidthPx: 1800, cellHeightPx: 1200, background: "#ffffff", elements,
});

describe("new layouts and elements", () => {
  it("starts with 4 photos and even 40/60 px margins", () => {
    const t = newTemplate();
    expect(shotCount(t)).toBe(4);
    const ys = t.elements.map((e) => e.y);
    expect(Math.min(...ys)).toBe(40);
    expect(Math.max(...t.elements.map((e) => e.y + e.height))).toBe(1160);
    expect(Math.min(...t.elements.map((e) => e.x))).toBe(60);
    expect(Math.max(...t.elements.map((e) => e.x + e.width))).toBe(1740);
  });

  it("makes unused ids", () => {
    expect(newId(layout([photo("photo-1", 0), photo("photo-2", 1)]), "photo")).toBe("photo-3");
    expect(newId(layout([photo("photo-2", 0)]), "photo")).toBe("photo-1");
  });

  it("adds a photo taking the next shot, a text and a shape on top", () => {
    let t = layout([photo("photo-1", 0)]);
    const p = addElement(t, "photo");
    expect(p.template.elements.at(-1)).toMatchObject({ id: p.id, type: "photo", shot: 1 });
    t = p.template;
    const text = addElement(t, "text");
    expect(text.template.elements.at(-1)).toMatchObject({ type: "text", text: "{event}", font: "Manrope" });
    const shape = addElement(t, "rect");
    expect(shape.template.elements.at(-1)).toMatchObject({ type: "rect", fill: "#f26b3a" });
  });

  it("adds a square QR code, dark on white", () => {
    const { template, id } = addElement(layout([photo("p", 0)]), "qr");
    const qr = template.elements.at(-1)!;
    expect(qr).toMatchObject({ id, type: "qr", color: "#000000", background: "#ffffff" });
    expect(qr.width).toBe(qr.height);
    expect(elementLabel(qr)).toBe("QR code");
  });

  it("stops adding photos at 12 shots and elements at 40", () => {
    const twelve = layout(Array.from({ length: MAX_SHOTS }, (_, i) => photo(`p${i}`, i)));
    expect(canAdd(twelve, "photo")).toBe(false);
    expect(canAdd(twelve, "text")).toBe(true);
    const forty = layout([photo("p", 0), ...Array.from({ length: 39 }, (_, i) => rect(`r${i}`))]);
    expect(canAdd(forty, "image")).toBe(false);
  });

  it("adds an image a third of the cell, keeping its shape", () => {
    const { template, id } = addImage(layout([photo("p", 0)]), "t-abc.png", 1000, 500);
    const el = template.elements.find((e) => e.id === id)!;
    expect(el).toMatchObject({ type: "image", file: "t-abc.png", width: 600, height: 300 });
  });
});

describe("editing elements", () => {
  it("renumbers shots so re-assigning a photo leaves no gap", () => {
    const t = layout([photo("a", 0), photo("b", 1), photo("c", 2)]);
    const moved = updateElement(t, "b", { shot: 0 });
    expect(moved.elements.map((e) => (e.type === "photo" ? e.shot : -1))).toEqual([0, 0, 1]);
    expect(compactShots([photo("x", 3), photo("y", 1)]).map((e) => (e.type === "photo" ? e.shot : -1))).toEqual([1, 0]);
  });

  it("won't remove the last photo, and compacts shots after a removal", () => {
    const one = layout([photo("a", 0), rect("r")]);
    expect(canRemove(one, "a")).toBe(false);
    expect(removeElement(one, "a")).toBe(one);
    expect(removeElement(one, "r").elements).toHaveLength(1);
    const three = layout([photo("a", 0), photo("b", 1), photo("c", 2)]);
    expect(shotCount(removeElement(three, "b"))).toBe(2);
  });

  it("moves layers up and down within bounds", () => {
    const t = layout([photo("a", 0), rect("r")]);
    expect(moveLayer(t, "a", 1).elements.map((e) => e.id)).toEqual(["r", "a"]);
    expect(moveLayer(t, "r", 1)).toBe(t);
    expect(moveLayer(t, "a", -1)).toBe(t);
  });

  it("aligns to the paper edges and centre, and fills the paper", () => {
    const t = layout([photo("a", 0)]);
    const el = t.elements[0]!;
    expect(alignPatch(el, "left", t)).toEqual({ x: 0 });
    expect(alignPatch(el, "hcenter", t)).toEqual({ x: 750 });
    expect(alignPatch(el, "right", t)).toEqual({ x: 1500 });
    expect(alignPatch(el, "top", t)).toEqual({ y: 0 });
    expect(alignPatch(el, "vcenter", t)).toEqual({ y: 500 });
    expect(alignPatch(el, "bottom", t)).toEqual({ y: 1000 });
    expect(fillPatch(t)).toEqual({ x: 0, y: 0, width: 1800, height: 1200, rotation: 0 });
  });

  it("snaps drags and never lets a box leave the paper entirely", () => {
    const t = layout([]);
    const start = { x: 100, y: 100, width: 300, height: 200 };
    expect(movedBox(start, 13, 26, t)).toEqual({ x: 110, y: 130 });
    expect(movedBox(start, -5000, 5000, t)).toEqual({ x: -280, y: 1180 });
  });

  it("resizes keeping the shape when locked", () => {
    const start = { width: 300, height: 200 };
    expect(resizedBox(start, 100, 0, true)).toEqual({ width: 400, height: 267 });
    expect(resizedBox(start, 100, 55, false)).toEqual({ width: 400, height: 260 });
    expect(resizedBox(start, -1000, -1000, false)).toEqual({ width: 20, height: 20 });
    expect(resizedBox(start, 9000, 0, false).width).toBe(3600);
  });

  it("sets one side from a number field, scaling the other when locked", () => {
    const el = photo("a", 0);
    expect(sizePatch(el, "width", 600, true)).toEqual({ width: 600, height: 400 });
    expect(sizePatch(el, "height", 100, true)).toEqual({ height: 100, width: 150 });
    expect(sizePatch(el, "width", 5, false)).toEqual({ width: 20 });
  });

  it("keeps angles within -180..180", () => {
    expect(normalizeAngle(195)).toBe(-165);
    expect(normalizeAngle(-190)).toBe(170);
    expect(normalizeAngle(90)).toBe(90);
  });

  it("scales every element, and text size, when the paper changes", () => {
    const text: LayoutElement = { ...base, id: "t", type: "text", text: "Hi", font: "Manrope", size: 90, color: "#000000", align: "center", bold: false, x: 180, y: 120, width: 900, height: 300 };
    const t = changePaper(layout([photo("a", 0), text]), "strip");
    expect(t).toMatchObject({ printSize: "2x6-strip", cellWidthPx: 600, cellHeightPx: 1800 });
    expect(t.elements[1]).toMatchObject({ x: 60, y: 180, width: 300, height: 100, size: 30 });
  });

  it("keeps an image's aspect ratio when the paper changes, instead of stretching it", () => {
    const t = changePaper(layout([image("i", 600, 300)]), "4r-portrait");
    expect(t.elements[0]).toMatchObject({ width: 400, height: 200 });
  });

  it("still scales a photo independently on each axis, since photos crop to fill", () => {
    const t = changePaper(layout([photo("a", 0)]), "4r-portrait");
    expect(t.elements[0]).toMatchObject({ width: 200, height: 300 });
  });

  it("leaves the layout untouched when choosing the paper it's already on", () => {
    const t = layout([photo("a", 0)]);
    expect(changePaper(t, "4r-landscape")).toBe(t);
  });
});

describe("text, save body and labels", () => {
  it("fills sample variables", () => {
    expect(sampleText("{event} · {date} {time} #{code} {x}", "Gigsmore Launch", new Date(2026, 8, 4, 9, 5))).toBe(
      "Gigsmore Launch · 4 Sep 2026 09:05 #a1b2c3d4 {x}"
    );
    expect(sampleText("{event}", "")).toBe("Event name");
  });

  it("sends only the fields the agent stores", () => {
    const fromApi = { ...layout([photo("a", 0)]), photoSlots: [{ x: 0, y: 0, width: 1, height: 1 }], overlayFile: null };
    const body = templateBody(fromApi);
    expect(Object.keys(body).sort()).toEqual(["background", "cellHeightPx", "cellWidthPx", "elements", "id", "name", "printSize"]);
  });

  it("labels elements for the layers list", () => {
    expect(elementLabel(photo("a", 1))).toBe("Photo 2");
    expect(elementLabel(rect("r"))).toBe("Shape");
    const text: LayoutElement = { ...base, id: "t", type: "text", text: "Gigsmore Launch Party 2026", font: "Manrope", size: 40, color: "#000000", align: "center", bold: false, x: 0, y: 0, width: 10, height: 10 };
    expect(elementLabel(text)).toBe("Text: Gigsmore Launch Pa…");
  });
});

describe("undo history", () => {
  const a = layout([photo("a", 0)]);
  const b = layout([photo("b", 0)]);
  const c = layout([photo("c", 0)]);

  it("undoes and redoes commits", () => {
    let h = historyCommit(historyCommit(historyOf(a), b), c);
    h = historyUndo(h);
    expect(h.present).toBe(b);
    h = historyUndo(h);
    expect(h.present).toBe(a);
    expect(historyUndo(h)).toBe(h);
    h = historyRedo(h);
    expect(h.present).toBe(b);
    expect(historyCommit(h, c).future).toEqual([]);
  });

  it("replaces without an undo step, and records a whole drag as one step", () => {
    const h = historyReplace(historyReplace(historyOf(a), b), c);
    expect(h.past).toEqual([]);
    const dragged = historyCommitFrom(h, a);
    expect(dragged.past).toEqual([a]);
    expect(dragged.present).toBe(c);
    expect(historyCommitFrom(dragged, dragged.present)).toBe(dragged);
  });

  it("merges a burst of edits to the same field into one undo step", () => {
    let h = historyCommit(historyOf(a), b, "el:text", 1_000);
    h = historyCommit(h, c, "el:text", 1_500);
    expect(h.past).toEqual([a]);
    expect(historyUndo(h).present).toBe(a);
  });

  it("starts a new step after a pause, for another field, or after an undo", () => {
    const d = layout([photo("d", 0)]);
    const paused = historyCommit(historyCommit(historyOf(a), b, "el:text", 1_000), c, "el:text", 1_000 + MERGE_MS);
    expect(paused.past).toEqual([a, b]);
    const other = historyCommit(historyCommit(historyOf(a), b, "el:text", 1_000), c, "el:size", 1_100);
    expect(other.past).toEqual([a, b]);
    const undone = historyUndo(historyCommit(historyCommit(historyOf(a), b), c, "el:text", 1_000));
    expect(historyCommit(undone, d, "el:text", 1_100).past).toEqual([a, b]);
  });

  it("keeps at most HISTORY_LIMIT undo steps", () => {
    let h = historyOf(a);
    for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) h = historyCommit(h, layout([photo(`p${i}`, 0)]));
    expect(h.past).toHaveLength(HISTORY_LIMIT);
  });
});

describe("cameras", () => {
  it("a photo without a camera uses the high one", () => {
    const t = layout([photo("a", 0), cam("b", 1, "low")]);
    expect(cameraForShot(t, 0)).toBe("high");
    expect(cameraForShot(t, 1)).toBe("low");
    expect(usesLowCamera(t)).toBe(true);
    expect(usesLowCamera(layout([photo("a", 0)]))).toBe(false);
  });

  it("setting a shot's camera changes every box showing that shot, and nothing else", () => {
    const t = setShotCamera(layout([photo("a", 0), photo("b", 1), photo("c", 1), rect("r")]), 1, "low");
    expect(t.elements.map((e) => (e.type === "photo" ? e.camera ?? "high" : "-"))).toEqual(["high", "low", "low", "-"]);
  });

  it("alternates high, low, high, low by shot number", () => {
    const t = alternateCameras(layout([photo("a", 0), photo("b", 1), photo("c", 2), photo("d", 3), photo("e", 1)]));
    expect(t.elements.map((e) => (e.type === "photo" ? e.camera : "-"))).toEqual(["high", "low", "high", "low", "low"]);
  });

  it("a box moved onto another shot takes that shot's camera", () => {
    const t = updateElement(layout([cam("a", 0, "high"), cam("b", 1, "low"), cam("c", 2, "high")]), "c", { shot: 1 });
    expect(t.elements.find((e) => e.id === "c")).toMatchObject({ shot: 1, camera: "low" });
  });

  it("a box moved onto a new shot keeps its own camera", () => {
    const t = updateElement(layout([cam("a", 0, "low"), cam("b", 1, "high")]), "a", { shot: 2 });
    // compactShots renumbers the gap away: a becomes shot 1, b shot 0.
    expect(t.elements.find((e) => e.id === "a")).toMatchObject({ camera: "low" });
  });

  it("prompts like today for a layout without the low camera", () => {
    const t = layout([photo("a", 0), photo("b", 1)]);
    expect(shotPrompt(t, 0)).toEqual({ text: "Photo 1 of 2 · look up at the camera", camera: "high" });
    expect(shotPrompt(layout([photo("a", 0)]), 0)).toEqual({ text: "Look up at the camera", camera: "high" });
  });

  it("names the camera when the layout uses both", () => {
    const t = layout([cam("a", 0, "high"), cam("b", 1, "low")]);
    expect(shotPrompt(t, 0)).toEqual({ text: "Photo 1 of 2 · look up at the top camera", camera: "high" });
    expect(shotPrompt(t, 1)).toEqual({ text: "Photo 2 of 2 · look down at the lower camera", camera: "low" });
  });
});
