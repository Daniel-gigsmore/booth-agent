import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadTemplate,
  saveTemplate,
  listTemplates,
  validateTemplate,
  withLegacyFields,
  shotCount,
  isOwnAsset,
} from "../src/compositor/template";
import { SHEET_WIDTH_PX, SHEET_HEIGHT_PX } from "../src/compositor/dimensions";

let templateDir: string;
let outsideSecret: string;

beforeEach(async () => {
  // templateDir and a sibling directory outside it - a successful traversal
  // would read outsideSecret via "../<outside-dir-name>/secret".
  const root = await mkdtemp(path.join(tmpdir(), "booth-template-"));
  templateDir = path.join(root, "templates");
  await mkdir(templateDir, { recursive: true });

  const outsideDir = path.join(root, "outside");
  await mkdir(outsideDir, { recursive: true });
  outsideSecret = path.join(outsideDir, "secret.json");
  await writeFile(outsideSecret, JSON.stringify({ leaked: true }));

  await writeFile(
    path.join(templateDir, "default.json"),
    JSON.stringify({
      id: "default",
      printSize: "4x6",
      cellWidthPx: SHEET_WIDTH_PX,
      cellHeightPx: SHEET_HEIGHT_PX,
      photoSlots: [{ x: 0, y: 0, width: SHEET_WIDTH_PX, height: SHEET_HEIGHT_PX }],
      overlayFile: null,
    })
  );
});

afterEach(async () => {
  await rm(path.dirname(templateDir), { recursive: true, force: true });
});

describe("loadTemplate templateId safety", () => {
  it("loads a legitimate flat templateId", () => {
    const template = loadTemplate(templateDir, "default");
    expect(template.id).toBe("default");
  });

  it("rejects a templateId that traverses out of templateDir before touching the filesystem", () => {
    const traversal = path.relative(templateDir, outsideSecret).replace(/\.json$/, "").replace(/\\/g, "/");
    expect(() => loadTemplate(templateDir, traversal)).toThrow(/Invalid templateId/);
  });

  it("rejects an absolute path used as templateId", () => {
    expect(() => loadTemplate(templateDir, outsideSecret.replace(/\.json$/, ""))).toThrow(/Invalid templateId/);
  });

  it("rejects a templateId containing a path separator even if it stays inside templateDir", () => {
    expect(() => loadTemplate(templateDir, "sub/default")).toThrow(/Invalid templateId/);
  });
});

const landscape = {
  id: "my-grid",
  name: "My grid",
  printSize: "4x6",
  cellWidthPx: SHEET_HEIGHT_PX,
  cellHeightPx: SHEET_WIDTH_PX,
  background: "#fbf8f3",
  elements: [
    { id: "p1", type: "photo", shot: 0, x: 60, y: 60, width: 810, height: 540 },
    { id: "p2", type: "photo", shot: 1, x: 930, y: 60, width: 810, height: 540 },
    { id: "t1", type: "text", text: "{event}", font: "Manrope", size: 64, color: "#222222", x: 60, y: 700, width: 1680, height: 120 },
    { id: "r1", type: "rect", fill: "#f26b3a", x: 0, y: 1100, width: 1800, height: 100 },
  ],
};

describe("element templates", () => {
  it("fills in defaults and counts shots", () => {
    const t = validateTemplate(landscape);
    expect(t.elements[0]).toMatchObject({ rotation: 0, hidden: false });
    expect(t.elements[2]).toMatchObject({ align: "center", bold: false });
    expect(t.elements[3]).toMatchObject({ radius: 0, opacity: 1 });
    expect(shotCount(t)).toBe(2);
  });

  it("lets the same shot appear twice and elements run past the edge", () => {
    const t = validateTemplate({
      ...landscape,
      elements: [...landscape.elements, { id: "p3", type: "photo", shot: 0, x: -50, y: -50, width: 3000, height: 200 }],
    });
    expect(shotCount(t)).toBe(2);
  });

  it.each([
    ["no photo", { elements: [landscape.elements[3]] }, /at least one photo/],
    ["a gap in the shots", { elements: [{ ...landscape.elements[0], shot: 1 }] }, /skips a photo/],
    ["a bad colour", { background: "red" }, /#rrggbb/],
    ["an unknown font", { elements: [landscape.elements[0], { ...landscape.elements[2], font: "Comic Sans" }] }, /unknown font/],
    ["duplicate element ids", { elements: [landscape.elements[0], { ...landscape.elements[1], id: "p1" }] }, /two elements/],
    ["too many elements", { elements: Array.from({ length: 41 }, (_, i) => ({ ...landscape.elements[0], id: `p${i}` })) }, /40/],
    ["over-long text", { elements: [landscape.elements[0], { ...landscape.elements[2], text: "x".repeat(501) }] }, /500/],
    ["a cell size that doesn't match the paper", { cellWidthPx: 1000 }, /must be/],
    ["an oversized element", { elements: [{ ...landscape.elements[0], width: 3601 }] }, /3600/],
  ])("rejects %s", (_name, patch, message) => {
    expect(() => validateTemplate({ ...landscape, ...patch })).toThrow(message);
  });
});

describe("legacy templates", () => {
  const legacy = {
    id: "old",
    printSize: "4x6",
    cellWidthPx: SHEET_HEIGHT_PX,
    cellHeightPx: SHEET_WIDTH_PX,
    photoSlots: [
      { x: 30, y: 30, width: 1110, height: 1140 },
      { x: 1170, y: 30, width: 600, height: 555 },
    ],
    overlayFile: "old-overlay.png",
  };

  it("converts slots to photo elements and the overlay to a full-cell top image", () => {
    const t = validateTemplate(legacy);
    expect(t.background).toBe("#ffffff");
    expect(t.elements).toEqual([
      { id: "photo-1", type: "photo", shot: 0, x: 30, y: 30, width: 1110, height: 1140, rotation: 0, hidden: false },
      { id: "photo-2", type: "photo", shot: 1, x: 1170, y: 30, width: 600, height: 555, rotation: 0, hidden: false },
      { id: "overlay", type: "image", file: "old-overlay.png", x: 0, y: 0, width: 1800, height: 1200, rotation: 0, hidden: false },
    ]);
  });

  it("round-trips through the legacy view the current kiosk reads", () => {
    const view = withLegacyFields(validateTemplate(legacy));
    expect(view.photoSlots).toEqual(legacy.photoSlots);
    expect(view.overlayFile).toBe("old-overlay.png");
    // The current kiosk sends back what it was given, with photoSlots edited.
    const moved = validateTemplate({ ...view, photoSlots: [{ x: 0, y: 0, width: 900, height: 600 }], overlayFile: null });
    expect(moved.elements).toHaveLength(1);
    expect(moved.elements[0]).toMatchObject({ type: "photo", x: 0, width: 900 });
  });

  it("reports no overlay when the top element isn't a full-cell image", () => {
    expect(withLegacyFields(validateTemplate(landscape)).overlayFile).toBeNull();
  });

  it("migrates every shipped default template", () => {
    const shipped = path.join(__dirname, "..", "assets", "templates");
    const ids = readdirSync(shipped).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    expect(ids.length).toBeGreaterThanOrEqual(4);
    for (const id of ids) expect(shotCount(loadTemplate(shipped, id))).toBeGreaterThan(0);
  });
});

describe("saveTemplate (layout editor)", () => {
  it("saves a layout and lists it", () => {
    saveTemplate(templateDir, landscape);
    expect(loadTemplate(templateDir, "my-grid").name).toBe("My grid");
    expect(listTemplates(templateDir).map((t) => t.id)).toContain("my-grid");
  });

  it("rejects a path-traversal id", () => {
    expect(() => saveTemplate(templateDir, { ...landscape, id: "../evil" })).toThrow(/Invalid templateId/);
  });

  it("recognises only the layout's own uploads as its assets", () => {
    expect(isOwnAsset("my-grid", "my-grid-3fa9c1.png")).toBe(true);
    expect(isOwnAsset("my-grid", "my-grid-overlay.png")).toBe(true);
    expect(isOwnAsset("my-grid", "my-grid-a-b.png")).toBe(false);
    expect(isOwnAsset("my", "my-grid-3fa9c1.png")).toBe(false);
    expect(isOwnAsset("my-grid", "my-grid-3fa9c1.gif")).toBe(false);
  });

  it("won't point an image at an arbitrary or missing file", async () => {
    const image = (file: string) => ({
      ...landscape,
      elements: [...landscape.elements, { id: "i1", type: "image", file, x: 0, y: 0, width: 10, height: 10 }],
    });
    expect(() => saveTemplate(templateDir, image("../../secret.png"))).toThrow(/doesn't belong/);
    expect(() => saveTemplate(templateDir, image("my-grid-abc123.png"))).toThrow(/missing/);
    await writeFile(path.join(templateDir, "my-grid-abc123.png"), "x");
    expect(saveTemplate(templateDir, image("my-grid-abc123.png")).elements).toHaveLength(5);
  });

  it("keeps a hand-placed image the layout already uses", async () => {
    await writeFile(path.join(templateDir, "frame.png"), "x");
    await writeFile(
      path.join(templateDir, "hand.json"),
      JSON.stringify({ ...landscape, id: "hand", elements: [...landscape.elements, { id: "f", type: "image", file: "frame.png", x: 0, y: 0, width: 10, height: 10 }] })
    );
    const current = loadTemplate(templateDir, "hand");
    expect(() => saveTemplate(templateDir, { ...current, name: "Renamed" })).not.toThrow();
  });
});
