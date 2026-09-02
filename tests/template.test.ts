import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadTemplate } from "../src/compositor/template";
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
    // The relative path from templateDir back to the sibling "outside" dir,
    // reused as templateId - if this were ever read, it proves traversal.
    const traversal = path.relative(templateDir, outsideSecret).replace(/\.json$/, "").replace(/\\/g, "/");

    expect(() => loadTemplate(templateDir, traversal)).toThrow(/Invalid templateId/);
  });

  it("rejects an absolute path used as templateId", () => {
    expect(() => loadTemplate(templateDir, outsideSecret.replace(/\.json$/, ""))).toThrow(
      /Invalid templateId/
    );
  });

  it("rejects a templateId containing a path separator even if it stays inside templateDir", () => {
    expect(() => loadTemplate(templateDir, "sub/default")).toThrow(/Invalid templateId/);
  });
});
