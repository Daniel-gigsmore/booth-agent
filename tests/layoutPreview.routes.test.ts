import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import sharp from "sharp";
import { buildHttpApp } from "../src/server/http";
import { renderPhoto } from "../src/compositor/compositor";
import { AgentContext } from "../src/server/context";
import { EventStore } from "../src/session/eventStore";
import { DEFAULT_SESSION } from "../src/session/sessionSettings";

// Spy on the sheet renderer so a test can see which text variables a preview used.
vi.mock("../src/compositor/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/compositor/compositor")>();
  return { ...actual, renderPhoto: vi.fn(actual.renderPhoto) };
});

const SECRET = "test-secret";
let root: string;
let templateDir: string;
let hotFolder: string;
let server: Server;
let base: string;
let events: EventStore;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "booth-preview-"));
  templateDir = path.join(root, "templates");
  hotFolder = path.join(root, "hot");
  await mkdir(templateDir, { recursive: true });
  await writeFile(path.join(root, "outside.png"), await sharp({ create: { width: 4, height: 4, channels: 4, background: "#ff0000" } }).png().toBuffer());
  events = EventStore.open(root, { id: "evt", name: "Gigsmore Launch", session: DEFAULT_SESSION });
  // Only the layout routes run here; they touch nothing but config.
  const ctx = {
    configStore: {
      current: {
        agent: { allowedOrigins: [], sharedSecret: SECRET },
        compositing: { templateDir, jpegQuality: 90 },
        printing: { hotFolderPath: hotFolder },
        storage: { dataDir: root },
      },
    },
    events,
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

const lastVariables = () => vi.mocked(renderPhoto).mock.calls.at(-1)![0].variables;

describe("layout preview", () => {
  it("renders an unsaved landscape draft upright, the way the guest holds the print", async () => {
    const res = await post("/layout-preview", draft());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/image\/jpeg/);
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([1800, 1200]);
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
    // The test print is the sheet the printer feeds: the landscape draft turned onto portrait 4x6.
    const sheet = await sharp(dropped.find((f) => path.basename(f) === `${jobId}.jpg`)!).metadata();
    expect([sheet.width, sheet.height]).toEqual([1200, 1800]);
    const composites = await filesUnder(path.join(root, "composites"));
    expect(composites.some((f) => path.basename(f) === `${jobId}.jpg`)).toBe(false);
  });
});

describe("layout preview {event}", () => {
  it("uses the active event's name, and follows a switch", async () => {
    await post("/layout-preview", draft());
    expect(lastVariables()).toMatchObject({ event: "Gigsmore Launch" });
    events.create({ name: "TUMI", date: "2026-10-05" });
    await post("/layout-preview", draft());
    expect(lastVariables()).toMatchObject({ event: "TUMI" });
  });
});
