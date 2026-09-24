import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { saveAsset, assetPath, saveTemplate, deleteTemplate } from "../src/compositor/template";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "booth-assets-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const png = () => sharp({ create: { width: 4, height: 4, channels: 4, background: "#ff0000" } }).png().toBuffer();
const jpeg = () => sharp({ create: { width: 4, height: 4, channels: 3, background: "#ff0000" } }).jpeg().toBuffer();

const layout = (id: string, files: string[]) => ({
  id,
  printSize: "4x6",
  cellWidthPx: 1200,
  cellHeightPx: 1800,
  elements: [
    { id: "p", type: "photo", shot: 0, x: 0, y: 0, width: 100, height: 100 },
    ...files.map((file, i) => ({ id: `i${i}`, type: "image", file, x: 0, y: 0, width: 10, height: 10 })),
  ],
});

describe("layout assets", () => {
  it("stores PNG and JPEG uploads under agent-chosen names", async () => {
    const a = await saveAsset(dir, "wed", await png());
    const b = await saveAsset(dir, "wed", await jpeg());
    expect(a).toMatch(/^wed-[0-9a-f]{12}\.png$/);
    expect(b).toMatch(/^wed-[0-9a-f]{12}\.jpg$/);
    expect(existsSync(path.join(dir, a))).toBe(true);
  });

  it("rejects anything that isn't a PNG or JPEG", async () => {
    await expect(saveAsset(dir, "wed", Buffer.from("GIF89a nope"))).rejects.toThrow(/PNG or JPEG/);
    await expect(saveAsset(dir, "wed", Buffer.alloc(0))).rejects.toThrow(/PNG or JPEG/);
    await expect(saveAsset(dir, "../x", await png())).rejects.toThrow(/Invalid templateId/);
  });

  it("serves only the layout's own files", async () => {
    const a = await saveAsset(dir, "wed", await png());
    expect(assetPath(dir, "wed", a)).toBe(path.join(dir, a));
    expect(() => assetPath(dir, "wed", "../booth.config.json")).toThrow(/no image/);
    expect(() => assetPath(dir, "other", a)).toThrow(/no image/);
  });

  it("deletes a layout's unused uploads when it is saved, and all of them when it is deleted", async () => {
    const keep = await saveAsset(dir, "wed", await png());
    const drop = await saveAsset(dir, "wed", await png());
    const other = await saveAsset(dir, "party", await png());
    saveTemplate(dir, layout("party", [other]));

    saveTemplate(dir, layout("wed", [keep]));
    expect(existsSync(path.join(dir, keep))).toBe(true);
    expect(existsSync(path.join(dir, drop))).toBe(false);

    deleteTemplate(dir, "wed");
    expect(existsSync(path.join(dir, keep))).toBe(false);
    expect(existsSync(path.join(dir, other))).toBe(true);
  });

  it("never deletes a file another layout references", async () => {
    const shared = await saveAsset(dir, "wed", await png());
    // Hand-edited: "party" points at a file named like one of wed's uploads.
    await writeFile(path.join(dir, "party.json"), JSON.stringify(layout("party", [shared])));
    saveTemplate(dir, layout("wed", []));
    expect(existsSync(path.join(dir, shared))).toBe(true);
  });

  it("doesn't fail the save when one stale asset can't be unlinked", async () => {
    // unlinkSync throws EPERM/EISDIR on a directory; simulates a file the OS
    // is still holding open (Windows) so the whole prune shouldn't abort.
    await mkdir(path.join(dir, "wed-abc123def456.png"));
    const drop = await saveAsset(dir, "wed", await png());
    expect(() => saveTemplate(dir, layout("wed", []))).not.toThrow();
    expect(existsSync(path.join(dir, drop))).toBe(false);
  });
});
