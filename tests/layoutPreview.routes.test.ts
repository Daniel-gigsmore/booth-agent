import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import sharp from "sharp";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";

const SECRET = "test-secret";
let root: string;
let templateDir: string;
let hotFolder: string;
let server: Server;
let base: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "booth-preview-"));
  templateDir = path.join(root, "templates");
  hotFolder = path.join(root, "hot");
  await mkdir(templateDir, { recursive: true });
  await writeFile(path.join(root, "outside.png"), await sharp({ create: { width: 4, height: 4, channels: 4, background: "#ff0000" } }).png().toBuffer());
  // Only the layout routes run here; they touch nothing but config.
  const ctx = {
    configStore: {
      current: {
        agent: { allowedOrigins: [], sharedSecret: SECRET },
        compositing: { templateDir, jpegQuality: 90 },
        printing: { hotFolderPath: hotFolder },
        event: { id: "evt", name: "Gigsmore Launch" },
        storage: { dataDir: root },
      },
    },
  } as unknown as AgentContext;
  server = buildHttpApp(ctx).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});

const post = (p: string, body: unknown) =>
  fetch(`${base}${p}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const draft = (extra: object[] = []) => ({
  id: "draft",
  name: "Draft",
  printSize: "4x6",
  cellWidthPx: 1800,
  cellHeightPx: 1200,
  elements: [
    { id: "p1", type: "photo", shot: 0, x: 60, y: 40, width: 810, height: 540 },
    { id: "p2", type: "photo", shot: 1, x: 930, y: 40, width: 810, height: 540 },
    { id: "t", type: "text", text: "{event}", font: "Manrope", size: 80, color: "#222222", x: 60, y: 700, width: 1680, height: 200 },
    ...extra,
  ],
});

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else out.push(full);
  }
  return out;
}

// The first render in a process pays for loading fonts (and fontconfig
// failing to find a cache dir); on a cold Windows CI runner that alone has
// gone past vitest's 5 s default.
describe("layout preview", { timeout: 20_000 }, () => {
  it("renders an unsaved draft as the portrait print sheet", async () => {
    const res = await post("/layout-preview", draft());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/image\/jpeg/);
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 1800]);
  });

  it("refuses a draft whose image points outside the layout", async () => {
    const bad = draft([{ id: "i", type: "image", file: "../outside.png", x: 0, y: 0, width: 10, height: 10 }]);
    const res = await post("/layout-preview", bad);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/doesn't belong/);
  });

  it("rejects an invalid draft", async () => {
    const res = await post("/layout-preview", { ...draft(), elements: [] });
    expect(res.status).toBe(400);
  });

  it("drops a test print straight into the hot folder", async () => {
    const res = await post("/layout-preview/print", draft());
    expect(res.status).toBe(202);
    const { jobId } = await res.json();
    expect(jobId).toMatch(/^test-/);
    const dropped = await filesUnder(hotFolder);
    expect(dropped.some((f) => path.basename(f) === `${jobId}.jpg`)).toBe(true);
    const composites = await filesUnder(path.join(root, "composites"));
    expect(composites.some((f) => path.basename(f) === `${jobId}.jpg`)).toBe(false);
  });
});
