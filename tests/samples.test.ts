import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { samplePhotos } from "../src/compositor/samples";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "booth-samples-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sample photos", () => {
  it("makes one 3:2 photo per shot and reuses them", async () => {
    const files = await samplePhotos(path.join(dir, "samples"), 3);
    expect(files.map((f) => path.basename(f))).toEqual(["sample-1.jpg", "sample-2.jpg", "sample-3.jpg"]);
    const meta = await sharp(files[0]!).metadata();
    expect([meta.width, meta.height]).toEqual([1800, 1200]);

    const before = (await stat(files[0]!)).mtimeMs;
    const again = await samplePhotos(path.join(dir, "samples"), 3);
    expect(again).toEqual(files);
    expect((await stat(again[0]!)).mtimeMs).toBe(before);
  });

  it("gives every shot of a 12-shot layout its own photo", async () => {
    expect(await samplePhotos(dir, 12)).toHaveLength(12);
  });
});
