import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { saveAsset, saveTemplate, loadTemplate, isOwnAsset } from "../src/compositor/template";
import { exportLayout, importLayout, copyLayout, freeTemplateId } from "../src/compositor/templateTransfer";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "booth-transfer-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const png = (color = "#ff0000") => sharp({ create: { width: 8, height: 8, channels: 4, background: color } }).png().toBuffer();

async function savedLayout(id: string, name: string) {
  const file = await saveAsset(dir, id, await png());
  return saveTemplate(dir, {
    id,
    name,
    printSize: "4x6",
    cellWidthPx: 1800,
    cellHeightPx: 1200,
    elements: [
      { id: "p", type: "photo", shot: 0, x: 0, y: 0, width: 900, height: 600 },
      { id: "logo", type: "image", file, x: 1000, y: 100, width: 400, height: 200 },
    ],
  });
}

// isOwnAsset, not a prefix match: "party-" would also match "party-copy-…".
const ownFiles = async (id: string) => (await readdir(dir)).filter((f) => isOwnAsset(id, f));

describe("layout files", () => {
  it("picks a free id from the name", async () => {
    await savedLayout("my-grid", "My grid");
    expect(freeTemplateId(dir, "My grid")).toBe("my-grid-2");
    expect(freeTemplateId(dir, "Wedding 4-up!")).toBe("wedding-4-up");
    expect(freeTemplateId(dir, "婚礼")).toBe("layout");
  });

  it("exports a layout with its images and imports it as a new layout", async () => {
    const original = await savedLayout("my-grid", "My grid");
    const bundle = await exportLayout(dir, "my-grid");
    expect(bundle.format).toBe("kachak-layout");
    expect(Object.keys(bundle.assets)).toHaveLength(1);

    const imported = await importLayout(dir, JSON.parse(JSON.stringify(bundle)));
    expect(imported.id).toBe("my-grid-2");
    expect(imported.name).toBe("My grid");
    const image = imported.elements.find((e) => e.type === "image")!;
    expect(image.type === "image" && image.file.startsWith("my-grid-2-")).toBe(true);
    const oldFile = original.elements.find((e) => e.type === "image")!;
    if (image.type !== "image" || oldFile.type !== "image") throw new Error("image element expected");
    expect(await readFile(path.join(dir, image.file))).toEqual(await readFile(path.join(dir, oldFile.file)));
    expect(loadTemplate(dir, "my-grid").elements).toEqual(original.elements);
  });

  it("rejects a file that isn't a layout, lacks an image, or carries a non-image", async () => {
    const bundle = await exportLayout(dir, (await savedLayout("a", "A")).id);
    await expect(importLayout(dir, { ...bundle, format: "other" })).rejects.toThrow(/isn't a Kachak layout file/);
    await expect(importLayout(dir, { ...bundle, assets: {} })).rejects.toThrow(/missing image/);
    const [file] = Object.keys(bundle.assets);
    await expect(importLayout(dir, { ...bundle, assets: { [file!]: Buffer.from("hello").toString("base64") } })).rejects.toThrow(/PNG or JPEG/);
  });

  it("rejects an asset larger than 10 MB", async () => {
    const bundle = await exportLayout(dir, (await savedLayout("big", "Big")).id);
    const [file] = Object.keys(bundle.assets);
    const huge = Buffer.alloc(10 * 1024 * 1024 + 1);
    await expect(
      importLayout(dir, { ...bundle, assets: { [file!]: huge.toString("base64") } })
    ).rejects.toThrow(/larger than 10 MB/);
  });

  it("leaves no stray images when an import fails part-way", async () => {
    const good = await png();
    const bundle = {
      format: "kachak-layout",
      version: 1,
      template: {
        id: "two",
        name: "Two images",
        printSize: "4x6",
        cellWidthPx: 1800,
        cellHeightPx: 1200,
        elements: [
          { id: "p", type: "photo", shot: 0, x: 0, y: 0, width: 900, height: 600 },
          { id: "a", type: "image", file: "two-aaa.png", x: 0, y: 0, width: 10, height: 10 },
          { id: "b", type: "image", file: "two-bbb.png", x: 0, y: 0, width: 10, height: 10 },
        ],
      },
      assets: { "two-aaa.png": good.toString("base64"), "two-bbb.png": Buffer.from("nope").toString("base64") },
    };
    await expect(importLayout(dir, bundle)).rejects.toThrow(/PNG or JPEG/);
    expect(await ownFiles("two-images")).toEqual([]);
    expect((await readdir(dir)).filter((f) => f.endsWith(".json"))).toEqual([]);
  });

  it("saves an edited draft as a new layout and leaves the original alone", async () => {
    const original = await savedLayout("party", "Party");
    const draft = { ...original, elements: original.elements.map((e) => (e.type === "photo" ? { ...e, x: 100 } : e)) };
    const copy = await copyLayout(dir, "party", draft, "Party copy");
    expect(copy.id).toBe("party-copy");
    expect(copy.elements[0]).toMatchObject({ type: "photo", x: 100 });
    expect(loadTemplate(dir, "party").elements[0]).toMatchObject({ x: 0 });
    expect(await ownFiles("party-copy")).toHaveLength(1);
    expect(await ownFiles("party")).toHaveLength(1);
  });

  it("gives concurrent imports of the same name separate layouts", async () => {
    const bundle = await exportLayout(dir, (await savedLayout("same", "Same")).id);
    const [a, b] = await Promise.all([importLayout(dir, bundle), importLayout(dir, bundle)]);
    expect(new Set([a.id, b.id]).size).toBe(2);
    expect(loadTemplate(dir, a.id).id).toBe(a.id);
    expect(loadTemplate(dir, b.id).id).toBe(b.id);
  });

  it("won't copy a draft that points at someone else's image", async () => {
    await savedLayout("party", "Party");
    await writeFile(path.join(dir, "secret.png"), await png());
    const draft = {
      ...loadTemplate(dir, "party"),
      elements: [
        { id: "p", type: "photo", shot: 0, x: 0, y: 0, width: 900, height: 600 },
        { id: "x", type: "image", file: "secret.png", x: 0, y: 0, width: 10, height: 10 },
      ],
    };
    await expect(copyLayout(dir, "party", draft, "Stolen")).rejects.toThrow(/doesn't belong/);
  });
});
