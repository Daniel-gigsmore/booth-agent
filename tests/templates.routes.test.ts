import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import sharp from "sharp";
import { buildHttpApp } from "../src/server/http";
import { AgentContext } from "../src/server/context";

const SECRET = "test-secret";
let dir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "booth-routes-"));
  await writeFile(
    path.join(dir, "old.json"),
    JSON.stringify({
      id: "old",
      printSize: "4x6",
      cellWidthPx: 1800,
      cellHeightPx: 1200,
      photoSlots: [{ x: 60, y: 60, width: 810, height: 540 }, { x: 930, y: 60, width: 810, height: 540 }],
      overlayFile: null,
    })
  );
  // Only the template routes run here; they touch nothing but config.
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
const png = () => sharp({ create: { width: 8, height: 8, channels: 4, background: "#ff0000" } }).png().toBuffer();

describe("layout routes", () => {
  it("lists legacy layouts as elements", async () => {
    const { templates } = await (await fetch(`${base}/templates`, { headers: auth })).json();
    expect(templates[0].elements).toHaveLength(2);
    expect(templates[0]).not.toHaveProperty("photoSlots");
    expect(templates[0]).not.toHaveProperty("overlayFile");
  });

  it("uploads an asset and saves a layout that uses it", async () => {
    const up = await fetch(`${base}/templates/new/assets`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "image/png" },
      body: await png(),
    });
    expect(up.status).toBe(201);
    const { file } = await up.json();

    const img = await fetch(`${base}/templates/new/assets/${file}?token=${SECRET}`);
    expect(img.status).toBe(200);

    const save = await fetch(`${base}/templates/new`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        printSize: "4x6",
        cellWidthPx: 1200,
        cellHeightPx: 1800,
        elements: [
          { id: "p", type: "photo", shot: 0, x: 0, y: 0, width: 600, height: 400 },
          { id: "i", type: "image", file, x: 0, y: 0, width: 1200, height: 1800 },
        ],
      }),
    });
    expect(save.status).toBe(200);
    expect((await save.json()).elements[1]).toMatchObject({ type: "image", file });
  });

  it("rejects a non-image upload and a foreign asset path", async () => {
    const up = await fetch(`${base}/templates/new/assets`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "image/png" },
      body: "not a png",
    });
    expect(up.status).toBe(400);
    expect((await fetch(`${base}/templates/new/assets/old.json`, { headers: auth })).status).toBe(404);
  });

  it("no longer serves the old overlay routes", async () => {
    expect((await fetch(`${base}/templates/old/overlay`, { headers: auth })).status).toBe(404);
  });

  it("lists and serves bundled fonts, and nothing else", async () => {
    const { fonts } = await (await fetch(`${base}/fonts`, { headers: auth })).json();
    expect(fonts.map((f: { family: string }) => f.family)).toContain("Manrope");
    expect((await fetch(`${base}/fonts/Manrope.ttf`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/fonts/..%2Fpackage.json`, { headers: auth })).status).toBe(404);
  });
});
