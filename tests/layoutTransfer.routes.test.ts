import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import sharp from "sharp";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";
import { saveAsset, saveTemplate } from "../src/compositor/template";

const SECRET = "test-secret";
let dir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "booth-transfer-routes-"));
  const file = await saveAsset(dir, "grid", await sharp({ create: { width: 8, height: 8, channels: 4, background: "#00ff00" } }).png().toBuffer());
  saveTemplate(dir, {
    id: "grid",
    name: "Grid",
    printSize: "4x6",
    cellWidthPx: 1800,
    cellHeightPx: 1200,
    elements: [
      { id: "p", type: "photo", shot: 0, x: 0, y: 0, width: 900, height: 600 },
      { id: "logo", type: "image", file, x: 1000, y: 100, width: 400, height: 200 },
    ],
  });
  const ctx = {
    configStore: {
      current: {
        agent: { allowedOrigins: [], sharedSecret: SECRET },
        compositing: { templateDir: dir },
        event: { id: "evt" },
        storage: { dataDir: dir },
      },
    },
  } as unknown as AgentContext;
  server = buildHttpApp(ctx).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const auth = { Authorization: `Bearer ${SECRET}` };
const postJson = (p: string, body: unknown, headers: Record<string, string> = auth) =>
  fetch(`${base}${p}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("layout file routes", () => {
  it("exports and re-imports a layout", async () => {
    const res = await fetch(`${base}/templates/grid/export`, { headers: auth });
    expect(res.status).toBe(200);
    const bundle = await res.json();
    const imported = await postJson("/layout-import", bundle);
    expect(imported.status).toBe(201);
    expect((await imported.json()).id).toBe("grid-2");
  });

  it("answers 404 for an unknown layout", async () => {
    expect((await fetch(`${base}/templates/nope/export`, { headers: auth })).status).toBe(404);
  });

  it("accepts layout files larger than the 5 MB limit other routes keep", async () => {
    // Noise doesn't compress, so this PNG is several MB, and more once base64'd.
    const big = await sharp({ create: { width: 1500, height: 1500, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 40 } } }).png().toBuffer();
    const bundle = await (await fetch(`${base}/templates/grid/export`, { headers: auth })).json();
    const [file] = Object.keys(bundle.assets);
    bundle.assets[file] = big.toString("base64");
    expect(bundle.assets[file].length).toBeGreaterThan(5 * 1024 * 1024);
    expect((await postJson("/layout-import", bundle)).status).toBe(201);
    // …while an ordinary route still refuses a body that size (the central
    // error handler answers body-parser's "too large" as an error status).
    const refused = await postJson("/templates/grid/copy", { name: "x", template: bundle.template, pad: bundle.assets[file] });
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });

  it("requires the shared secret before reading an import body", async () => {
    expect((await postJson("/layout-import", { format: "kachak-layout" }, {})).status).toBe(401);
  });

  it("saves a draft as a new layout", async () => {
    const template = await (await fetch(`${base}/templates/grid/export`, { headers: auth })).json().then((b) => b.template);
    const res = await postJson("/templates/grid/copy", { name: "Grid copy", template });
    expect(res.status).toBe(201);
    expect((await res.json()).id).toBe("grid-copy");
    expect((await postJson("/templates/grid/copy", { name: "", template })).status).toBe(400);
  });
});
