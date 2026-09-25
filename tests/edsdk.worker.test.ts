import { describe, it, expect, beforeEach } from "vitest";
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
