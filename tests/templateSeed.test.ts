import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureTemplateDir, BUNDLED_TEMPLATE_DIR } from "../src/compositor/templateSeed";
import { loadTemplate } from "../src/compositor/template";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "booth-seed-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ensureTemplateDir", () => {
  it("creates a missing templateDir (nested) and fills it with the bundled layouts", async () => {
    const dir = path.join(root, "BoothAgent", "templates");
    const result = ensureTemplateDir(dir);
    expect(result.created).toBe(true);
    const bundled = (await readdir(BUNDLED_TEMPLATE_DIR)).filter((f) => f.endsWith(".json")).sort();
    expect(bundled.length).toBeGreaterThan(0);
    expect(result.seeded.sort()).toEqual(bundled);
    expect((await readdir(dir)).sort()).toEqual(bundled);
  });

  it("seeds layouts the agent can load", () => {
    const dir = path.join(root, "templates");
    ensureTemplateDir(dir);
    expect(() => loadTemplate(dir, "default-4r-grid")).not.toThrow();
  });

  it("seeds an existing but empty templateDir", async () => {
    const dir = path.join(root, "templates");
    await mkdir(dir);
    const result = ensureTemplateDir(dir);
    expect(result.created).toBe(false);
    expect(result.seeded.length).toBeGreaterThan(0);
  });

  it("leaves a templateDir that already has layouts alone, so a deleted default stays deleted", async () => {
    const dir = path.join(root, "templates");
    await mkdir(dir);
    await writeFile(path.join(dir, "mine.json"), "{}");
    const result = ensureTemplateDir(dir);
    expect(result).toEqual({ created: false, seeded: [] });
    expect(await readdir(dir)).toEqual(["mine.json"]);
    expect(await readFile(path.join(dir, "mine.json"), "utf8")).toBe("{}");
  });

  it("still creates the folder when there are no bundled layouts", async () => {
    const dir = path.join(root, "templates");
    const result = ensureTemplateDir(dir, path.join(root, "nope"));
    expect(result).toEqual({ created: true, seeded: [] });
    expect(await readdir(dir)).toEqual([]);
  });
});
