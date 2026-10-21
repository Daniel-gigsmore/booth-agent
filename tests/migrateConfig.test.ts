import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrateConfig, migrateConfigFile, KIOSK_ORIGIN } from "../src/service/migrateConfig";
import { BoothConfigSchema } from "../src/config/schema";

const example = () => JSON.parse(require("node:fs").readFileSync(path.join(__dirname, "..", "booth.config.example.json"), "utf8"));

/** A config from before the one-click installer: no kiosk origin, no canon.driver, no kiosk section. */
const old = () => {
  const c = example();
  c.agent.allowedOrigins = [];
  delete c.capture.canon.driver;
  delete c.capture.canon.edsdkDllPath;
  delete c.kiosk;
  return c;
};

describe("migrateConfig", () => {
  it("leaves the example config (what new booths get) unchanged", () => {
    expect(migrateConfig(example(), { fileExists: () => true }).changes).toEqual([]);
  });

  it("brings an old config up to date when the EDSDK is installed", () => {
    const { config, changes } = migrateConfig(old(), { fileExists: () => true });
    const c = config as any;
    expect(c.agent.allowedOrigins).toEqual([KIOSK_ORIGIN]);
    expect(c.capture.canon.driver).toBe("edsdk");
    expect(c.kiosk).toEqual({ downloadUrl: "" });
    expect(changes).toHaveLength(3);
    expect(BoothConfigSchema.safeParse(config).success).toBe(true);
  });

  it("keeps digiCamControl when the EDSDK isn't installed", () => {
    const c = migrateConfig(old(), { fileExists: () => false }).config as any;
    expect(c.capture.canon.driver).toBeUndefined();
  });

  it("checks the configured edsdkDllPath", () => {
    const o = old();
    o.capture.canon.edsdkDllPath = "D:\\sdk\\EDSDK.dll";
    const seen: string[] = [];
    migrateConfig(o, { fileExists: (p) => (seen.push(p), true) });
    expect(seen).toEqual(["D:\\sdk\\EDSDK.dll"]);
  });

  it("never overrides what the operator set", () => {
    const o = old();
    o.agent.allowedOrigins = ["http://192.168.1.5:4173", KIOSK_ORIGIN];
    o.capture.canon.driver = "digicamcontrol";
    o.kiosk = { downloadUrl: "https://x/?id={captureId}" };
    const { config, changes } = migrateConfig(o, { fileExists: () => true });
    expect(changes).toEqual([]);
    expect(config).toEqual(o);
  });

  it("does not mutate its input", () => {
    const o = old();
    const before = JSON.stringify(o);
    migrateConfig(o, { fileExists: () => true });
    expect(JSON.stringify(o)).toBe(before);
  });
});

describe("migrateConfigFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "booth-migrate-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rewrites the file (BOM from Notepad included) and keeps a backup of the original", async () => {
    const file = path.join(dir, "booth.config.json");
    const original = "\uFEFF" + JSON.stringify(old(), null, 2);
    await writeFile(file, original, "utf8");
    const changes = migrateConfigFile(file, { fileExists: () => true });
    expect(changes.some((c) => c.startsWith("backup: "))).toBe(true);
    const written = JSON.parse(await readFile(file, "utf8"));
    expect(written.capture.canon.driver).toBe("edsdk");
    const backups = (await readdir(dir)).filter((f) => f.startsWith("booth.config.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(dir, backups[0]!), "utf8")).toBe(original);
  });

  it("doesn't touch an up-to-date file", async () => {
    const file = path.join(dir, "booth.config.json");
    await writeFile(file, JSON.stringify(example()), "utf8");
    expect(migrateConfigFile(file, { fileExists: () => true })).toEqual([]);
    expect(await readdir(dir)).toEqual(["booth.config.json"]);
  });
});
