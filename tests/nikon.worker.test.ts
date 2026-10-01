import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NikonWorker, modelName } from "../src/camera/nikon/NikonWorker";
import { NK } from "../src/camera/nikon/nikonLayout";
import { WorkerEvent } from "../src/camera/edsdk/protocol";
import { FakeNikon } from "./helpers/fakeNikon";
import { fakeClock } from "./helpers/fakeEdsdk";

let nikon: FakeNikon;
let clock: ReturnType<typeof fakeClock>;
let events: WorkerEvent[];
let worker: NikonWorker;
let dir: string;

async function makeWorker() {
  nikon = new FakeNikon();
  clock = fakeClock(1_000_000);
  events = [];
  dir = mkdtempSync(path.join(tmpdir(), "nikon-worker-"));
  worker = new NikonWorker(nikon, (e) => events.push(e), path.join(dir, "default"), clock);
  await worker.start();
}

const states = () => events.filter((e) => e.type === "state");
const logs = (level: string) => events.filter((e) => e.type === "log" && e.level === level).map((e) => (e as { message: string }).message);
const dest = () => path.join(dir, "captures", "nikon-1.jpg");

async function connected() {
  await worker.tick();
  expect(worker.connected).toBe(true);
}

describe("NikonWorker connection", () => {
  beforeEach(makeWorker);

  it("names the model with the brand", () => {
    expect(modelName("Z 30")).toBe("Nikon Z 30");
    expect(modelName("Nikon Z 30")).toBe("Nikon Z 30");
  });

  it("connects on the first tick and makes the camera send photos to the PC", async () => {
    await worker.tick();
    expect(worker.connected).toBe(true);
    expect(nikon.calls).toContain("connect:7");
    expect(nikon.saveMedia).toBe(NK.SAVE_MEDIA_SDRAM);
    expect(states()).toEqual([{ type: "state", connected: true, model: "Nikon Z 30", serial: null }]);
  });

  it("refuses to start when the SDK won't initialize", async () => {
    const failing = new FakeNikon();
    failing.initErr = -117;
    const w = new NikonWorker(failing, () => undefined, path.join(dir, "default"), clock);
    await expect(w.start()).rejects.toThrow(/InitializeSDK failed: UnexpectedError/);
  });

  it("reports 'no camera' once and keeps scanning every second", async () => {
    nikon.devicesList = [];
    await worker.tick();
    clock.advance(500);
    await worker.tick();
    clock.advance(500);
    await worker.tick();
    expect(nikon.calls.filter((c) => c === "devices")).toHaveLength(2);
    expect(states()).toEqual([{ type: "state", connected: false, model: null, serial: null }]);
  });

  it("says when another program holds the camera", async () => {
    nikon.devicesList = [{ id: 7, name: "Z 30", available: false }];
    await worker.tick();
    expect(worker.connected).toBe(false);
    expect(logs("warn").join()).toMatch(/another program has it/);
  });

  it("waits 15 s before retrying a camera it could not open", async () => {
    nikon.connectErr = NK.OPEN_SESSION_FAILED;
    await worker.tick();
    clock.advance(1_000);
    await worker.tick();
    expect(nikon.calls.filter((c) => c === "connect:7")).toHaveLength(1);
    nikon.connectErr = NK.OK;
    clock.advance(14_000);
    await worker.tick();
    expect(worker.connected).toBe(true);
  });

  it("drops the camera when it leaves the device list", async () => {
    await connected();
    nikon.devicesList = [];
    nikon.event(NK.EVENT_DEVICE_INFO_CHANGED);
    await worker.tick();
    expect(worker.connected).toBe(false);
    expect(nikon.calls).toContain("disconnect");
    expect(states().at(-1)).toEqual({ type: "state", connected: false, model: null, serial: null });
  });

  it("also notices an unplug without the event, on the periodic check", async () => {
    await connected();
    nikon.devicesList = [];
    clock.advance(3_000);
    await worker.tick();
    expect(worker.connected).toBe(false);
  });

  it("publishes the battery level", async () => {
    await connected();
    await worker.tick();
    const status = events.filter((e) => e.type === "status").at(-1);
    expect(status).toMatchObject({ type: "status", detail: { battery: 80 } });
  });

  it("releases everything on shutdown", async () => {
    await connected();
    await worker.shutdown();
    expect(nikon.calls).toContain("disconnect");
    expect(nikon.terminated).toBe(true);
  });
});

describe("NikonWorker capture", () => {
  beforeEach(async () => {
    await makeWorker();
    await connected();
  });

  it("moves the photo the SDK saved to the destination and cleans up its folder", async () => {
    await worker.capture(dest());
    expect(readFileSync(dest(), "utf8")).toBe("photo DSC_0001.JPG");
    expect(nikon.shots).toHaveLength(1);
    expect(nikon.shots[0]!.autoFocus).toBe(true);
    expect(existsSync(nikon.shots[0]!.dir)).toBe(false);
    expect(readdirSync(path.dirname(dest()))).toEqual(["nikon-1.jpg"]);
  });

  it("takes the photo as soon as the SDK says it is saved", async () => {
    nikon.announceSaved = true;
    const start = clock.now();
    await worker.capture(dest());
    expect(clock.now() - start).toBe(0);
    expect(readFileSync(dest(), "utf8")).toBe("photo DSC_0001.JPG");
  });

  it("without that event, waits until the file has stopped growing", async () => {
    const start = clock.now();
    await worker.capture(dest());
    expect(clock.now() - start).toBeGreaterThanOrEqual(600);
  });

  it("takes the JPEG of a RAW + JPEG pair", async () => {
    nikon.shotFiles = ["DSC_0002.NEF", "DSC_0002.JPG"];
    await worker.capture(dest());
    expect(readFileSync(dest(), "utf8")).toBe("photo DSC_0002.JPG");
  });

  it("retakes without autofocus when the camera can't focus", async () => {
    nikon.shootResults = [NK.OUT_OF_FOCUS];
    await worker.capture(dest());
    expect(nikon.shots.map((s) => s.autoFocus)).toEqual([true, false]);
    expect(existsSync(dest())).toBe(true);
  });

  it("waits out a busy camera", async () => {
    nikon.shootResults = [NK.DEVICE_BUSY, NK.DEVICE_BUSY];
    await worker.capture(dest());
    expect(nikon.shots).toHaveLength(3);
  });

  it("stops live view and retries when the camera refuses to shoot during it", async () => {
    worker.frame();
    await new Promise((r) => setImmediate(r));
    expect(nikon.liveview).toBe(true);
    nikon.shootResults = [NK.INVALID_STATE];
    await worker.capture(dest());
    expect(nikon.calls).toContain("stopLiveView");
    expect(nikon.shots).toHaveLength(2);
  });

  it("explains a RAW-only camera instead of timing out", async () => {
    nikon.shotFiles = ["DSC_0003.NEF"];
    await expect(worker.capture(dest())).rejects.toThrow(/only a RAW file/);
    expect(existsSync(dest())).toBe(false);
    expect(readdirSync(path.dirname(dest()))).toEqual([]);
  });

  it("gives up before the agent's 12 s timeout when no photo arrives", async () => {
    nikon.writeFiles = false;
    const start = clock.now();
    await expect(worker.capture(dest())).rejects.toThrow(/did not reach the PC in time/);
    expect(clock.now() - start).toBeLessThan(12_000);
  });

  it("fails at once when the SDK says the photo was not saved", async () => {
    nikon.writeFiles = false;
    nikon.onShoot = () => nikon.event(NK.EVENT_STORAGE_FULL_IMAGE_NOT_SAVED);
    const start = clock.now();
    await expect(worker.capture(dest())).rejects.toThrow(/drive is full/);
    expect(clock.now() - start).toBeLessThan(1_000);
  });

  it("drops the connection when the camera vanished mid-shot", async () => {
    nikon.shootResults = [NK.DEVICE_NOT_AVAILABLE];
    await expect(worker.capture(dest())).rejects.toThrow(/DeviceNotAvailable/);
    await new Promise((r) => setImmediate(r));
    expect(worker.connected).toBe(false);
  });

  it("records the failure for /health", async () => {
    nikon.shootResults = [-117];
    await expect(worker.capture(dest())).rejects.toThrow(/Nikon shot failed: UnexpectedError/);
    const status = events.filter((e) => e.type === "status").at(-1);
    expect(status).toMatchObject({ detail: { lastError: { message: "Nikon shot failed: UnexpectedError (-117)" } } });
  });

  it("refuses without a camera", async () => {
    nikon.devicesList = [];
    nikon.event(NK.EVENT_DEVICE_INFO_CHANGED);
    await worker.tick();
    await expect(worker.capture(dest())).rejects.toThrow(/No Nikon camera connected/);
  });
});

describe("NikonWorker live view", () => {
  beforeEach(async () => {
    await makeWorker();
    await connected();
  });

  it("starts live view on the first request and serves pushed frames while they are fresh", async () => {
    expect(worker.frame()).toBeNull();
    await new Promise((r) => setImmediate(r));
    expect(nikon.calls.filter((c) => c === "startLiveView")).toHaveLength(1);
    nikon.frame(Buffer.from("frame-1"));
    expect(Buffer.from(worker.frame()!).toString()).toBe("frame-1");
    clock.advance(1_500);
    expect(worker.frame()).toBeNull();
    expect(nikon.calls.filter((c) => c === "startLiveView")).toHaveLength(1);
  });

  it("turns live view off after 10 s without a request", async () => {
    worker.frame();
    await new Promise((r) => setImmediate(r));
    clock.advance(10_000);
    await worker.tick();
    expect(nikon.liveview).toBe(false);
  });

  it("logs a refusal to start live view once, not per frame", async () => {
    nikon.liveviewErr = -109;
    for (let i = 0; i < 3; i++) {
      worker.frame();
      await new Promise((r) => setImmediate(r));
    }
    expect(logs("warn").filter((m) => m.includes("live view would not start"))).toHaveLength(1);
  });
});
