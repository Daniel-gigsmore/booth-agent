import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CameraWorker } from "../src/camera/edsdk/CameraWorker";
import { EDS } from "../src/camera/edsdk/edsdkApi";
import { WorkerEvent } from "../src/camera/edsdk/protocol";
import { FakeEds, fakeClock } from "./helpers/fakeEdsdk";

let eds: FakeEds;
let clock: ReturnType<typeof fakeClock>;
let events: WorkerEvent[];
let worker: CameraWorker;

function makeWorker() {
  eds = new FakeEds();
  clock = fakeClock(1_000_000);
  events = [];
  worker = new CameraWorker(eds, (e) => events.push(e), clock);
  worker.start();
}

const states = () => events.filter((e) => e.type === "state");

describe("CameraWorker connection", () => {
  beforeEach(makeWorker);

  it("connects on the first tick and puts the camera in host-save mode", () => {
    worker.tick();
    expect(worker.connected).toBe(true);
    expect(states()).toEqual([{ type: "state", connected: true, model: "Canon EOS R100" }]);
    expect(eds.props.get(EDS.PROP_SAVE_TO)).toBe(EDS.SAVE_TO_HOST);
  });

  it("scans once a second while no camera is plugged in", () => {
    eds.camera = null;
    worker.tick();
    clock.advance(500);
    worker.tick();
    clock.advance(500);
    worker.tick();
    expect(eds.calls.filter((c) => c === "firstCamera")).toHaveLength(2);
    expect(worker.connected).toBe(false);
  });

  it("re-initializes EDSDK after 5 empty scans in case its camera list went stale", () => {
    eds.camera = null;
    for (let i = 0; i < 5; i++) {
      worker.tick();
      clock.advance(1000);
    }
    expect(eds.calls.filter((c) => c === "terminate")).toHaveLength(1);
    expect(eds.calls.filter((c) => c === "initialize")).toHaveLength(2); // start() + re-init
  });

  it("drops the session on a camera shutdown and reconnects when it comes back", () => {
    worker.tick();
    eds.unplug();
    worker.tick();
    expect(worker.connected).toBe(false);
    expect(eds.sessionOpen).toBe(false);
    expect(states().at(-1)).toEqual({ type: "state", connected: false, model: null });

    eds.camera = "Canon EOS R100";
    clock.advance(1000);
    worker.tick();
    expect(worker.connected).toBe(true);
    expect(states().at(-1)).toMatchObject({ connected: true });
  });

  it("releases the shutter right after opening a session, before the rest of setup", () => {
    worker.tick();
    expect(eds.presses[0]).toBe(EDS.SHUTTER_OFF);
  });

  it("treats a setup failure (setU32 SaveTo) after openSession as a disconnect, and retries the next scan", () => {
    eds.setU32Fail.set(EDS.PROP_SAVE_TO, [EDS.ERR_DEVICE_BUSY]);
    worker.tick();
    expect(worker.connected).toBe(false);
    expect(eds.sessionOpen).toBe(false);
    expect(states().some((s) => s.connected)).toBe(false);

    clock.advance(1000);
    worker.tick();
    expect(worker.connected).toBe(true);
    expect(states().at(-1)).toMatchObject({ connected: true });
  });

  it("treats a setup failure (setObjectHandler) after openSession as a disconnect, and retries the next scan", () => {
    eds.objectHandlerResults = [EDS.ERR_DEVICE_BUSY];
    worker.tick();
    expect(worker.connected).toBe(false);
    expect(eds.sessionOpen).toBe(false);
    expect(states().some((s) => s.connected)).toBe(false);

    clock.advance(1000);
    worker.tick();
    expect(worker.connected).toBe(true);
    expect(states().at(-1)).toMatchObject({ connected: true });
  });

  it("keeps the camera awake every 60 s", () => {
    worker.tick();
    const keepAwakes = () => eds.commands.filter((c) => c.command === EDS.CMD_EXTEND_SHUTDOWN_TIMER).length;
    clock.advance(59_000);
    worker.tick();
    expect(keepAwakes()).toBe(0);
    clock.advance(1_000);
    worker.tick();
    expect(keepAwakes()).toBe(1);
  });
});

const dest = () => path.join(mkdtempSync(path.join(tmpdir(), "edsdk-")), "canon-x.jpg");

describe("CameraWorker capture", () => {
  beforeEach(() => {
    makeWorker();
    worker.tick(); // connected
  });

  it("presses fully, always releases, and downloads the JPEG to destPath", async () => {
    const file = dest();
    await worker.capture(file);
    expect(eds.presses).toEqual([EDS.SHUTTER_OFF, EDS.SHUTTER_COMPLETELY, EDS.SHUTTER_OFF]);
    expect(existsSync(file)).toBe(true);
  });

  it("on autofocus failure (8D01) releases, then takes the shot without autofocus", async () => {
    eds.pressResults = [EDS.ERR_TAKE_PICTURE_AF_NG];
    await worker.capture(dest());
    expect(eds.presses).toEqual([
      EDS.SHUTTER_OFF,
      EDS.SHUTTER_COMPLETELY, EDS.SHUTTER_OFF,
      EDS.SHUTTER_COMPLETELY_NON_AF, EDS.SHUTTER_OFF,
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "log", level: "warn" }));
  });

  it("on busy (81) releases, waits 500 ms and retries once", async () => {
    eds.pressResults = [EDS.ERR_DEVICE_BUSY];
    const before = clock.now();
    await worker.capture(dest());
    expect(eds.presses).toEqual([
      EDS.SHUTTER_OFF,
      EDS.SHUTTER_COMPLETELY, EDS.SHUTTER_OFF,
      EDS.SHUTTER_COMPLETELY, EDS.SHUTTER_OFF,
    ]);
    expect(clock.now() - before).toBeGreaterThanOrEqual(500);
  });

  it("fails on any other shutter error, still releasing the button", async () => {
    eds.pressResults = [0x2a];
    await expect(worker.capture(dest())).rejects.toThrow("0x2A");
    expect(eds.presses).toEqual([EDS.SHUTTER_OFF, EDS.SHUTTER_COMPLETELY, EDS.SHUTTER_OFF]);
  });

  it("cancels a non-JPEG transfer and keeps the JPEG", async () => {
    eds.photoNames = ["IMG_0001.CR3", "IMG_0001.JPG"];
    const file = dest();
    await worker.capture(file);
    expect(eds.cancels).toEqual(["IMG_0001.CR3"]);
    expect(eds.downloads).toEqual([{ name: "IMG_0001.JPG", path: file }]);
  });

  it("times out after 10 s with no photo", async () => {
    eds.photoNames = [];
    await expect(worker.capture(dest())).rejects.toThrow("timed out");
  });

  it("fails fast when the camera is unplugged mid-capture", async () => {
    eds.photoNames = [];
    eds.unplug();
    await expect(worker.capture(dest())).rejects.toThrow("disconnected");
    expect(worker.connected).toBe(false);
  });

  it("refuses to capture with no camera", async () => {
    eds.unplug();
    worker.tick();
    await expect(worker.capture(dest())).rejects.toThrow("No Canon camera connected");
  });
});

describe("CameraWorker live view", () => {
  beforeEach(() => {
    makeWorker();
    worker.tick();
  });

  it("turns live view on at the first frame request and returns the frame", () => {
    expect(worker.frame()).toEqual(Buffer.from("frame"));
    expect(eds.evfOutput & EDS.EVF_OUTPUT_PC).toBe(EDS.EVF_OUTPUT_PC);
    expect(eds.evfOutput & 1).toBe(1); // the camera's own screen bit is left alone
  });

  it("returns null while the camera has no frame ready yet", () => {
    eds.evfFrame = { err: EDS.ERR_OBJECT_NOTREADY, jpeg: null };
    expect(worker.frame()).toBeNull();
  });

  it("turns live view off after 10 s without a frame request, and back on when asked", () => {
    worker.frame();
    clock.advance(9_999);
    worker.tick();
    expect(eds.evfOutput & EDS.EVF_OUTPUT_PC).toBe(EDS.EVF_OUTPUT_PC);
    clock.advance(1);
    worker.tick();
    expect(eds.evfOutput & EDS.EVF_OUTPUT_PC).toBe(0);
    worker.frame();
    expect(eds.evfOutput & EDS.EVF_OUTPUT_PC).toBe(EDS.EVF_OUTPUT_PC);
  });

  it("returns null during a capture instead of queueing behind it", async () => {
    eds.photoNames = [];
    const capture = worker.capture(dest());
    expect(worker.frame()).toBeNull();
    await expect(capture).rejects.toThrow("timed out");
  });

  it("returns null with no camera", () => {
    eds.unplug();
    worker.tick();
    expect(worker.frame()).toBeNull();
  });
});

describe("CameraWorker shutdown", () => {
  it("releases the shutter, stops live view, closes the session and terminates EDSDK", () => {
    makeWorker();
    worker.tick();
    worker.frame();
    worker.shutdown();
    expect(eds.presses.at(-1)).toBe(EDS.SHUTTER_OFF);
    expect(eds.evfOutput & EDS.EVF_OUTPUT_PC).toBe(0);
    expect(eds.sessionOpen).toBe(false);
    expect(eds.calls.at(-1)).toBe("terminate");
  });
});
