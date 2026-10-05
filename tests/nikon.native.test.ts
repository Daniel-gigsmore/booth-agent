import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import koffi from "koffi";
import { loadNikon } from "../src/camera/nikon/nikonNative";
import { NikonWorker } from "../src/camera/nikon/NikonWorker";
import { NK } from "../src/camera/nikon/nikonLayout";
import { WorkerEvent } from "../src/camera/edsdk/protocol";

/**
 * The real koffi binding against a mock SDK (tests/fixtures/mock-nikon-sdk.c)
 * built with the system C compiler. The mock has the SDK's exports and pack(2)
 * layouts, allocates with our malloc, and calls back from its own threads -
 * so this catches a wrong offset, a missed free (glibc aborts on a bad one) or
 * a deadlocking call, which the FakeNikon-based tests can't.
 *
 * Linux only (the binding takes malloc/free from libc there); skipped where
 * there is no C compiler.
 */
function buildMock(): string | null {
  if (process.platform !== "linux") return null;
  const out = path.join(mkdtempSync(path.join(tmpdir(), "mock-nikon-")), "libmocknikon.so");
  try {
    execFileSync("cc", ["-shared", "-fPIC", "-O1", "-o", out, path.join(__dirname, "fixtures", "mock-nikon-sdk.c"), "-lpthread"], {
      stdio: "pipe",
    });
    return out;
  } catch {
    return null;
  }
}

const library = buildMock();

describe.skipIf(!library)("Nikon native binding (mock SDK)", () => {
  let events: WorkerEvent[];
  let worker: NikonWorker;
  let dir: string;
  let mock: {
    unplug: () => void;
    saveMedia: () => number;
    lastAutoFocus: () => number;
    uiAnswer: () => number;
    settingIndex: (cap: number) => number;
    evIndex: () => number;
    refuseNextSet: (cap: number) => void;
  };

  const waitFor = async (check: () => boolean | Promise<boolean>, what: string, ms = 3_000) => {
    const until = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  beforeAll(async () => {
    const lib = koffi.load(library!);
    mock = {
      unplug: lib.func("void mock_unplug()"),
      saveMedia: lib.func("uint32 mock_save_media()"),
      lastAutoFocus: lib.func("int32 mock_last_autofocus()"),
      uiAnswer: lib.func("uint32 mock_ui_answer()"),
      settingIndex: lib.func("uint32 mock_setting_index(uint32 cap)"),
      evIndex: lib.func("uint32 mock_ev_index()"),
      refuseNextSet: lib.func("void mock_refuse_next_set(uint32 cap)"),
    };
    dir = mkdtempSync(path.join(tmpdir(), "nikon-native-"));
    events = [];
    worker = new NikonWorker(loadNikon(dir, { libraryPath: library! }), (e) => events.push(e), path.join(dir, "default"));
    await worker.start();
  });

  afterAll(async () => {
    await worker?.shutdown();
  });

  it("initializes and answers the SDK's UI request with its default", () => {
    expect(mock.uiAnswer()).toBe(1);
  });

  it("lists, connects and switches the camera to save to the PC", async () => {
    await worker.tick();
    expect(worker.connected).toBe(true);
    expect(events).toContainEqual({ type: "state", connected: true, model: "Nikon Z 30", serial: null });
    expect(mock.saveMedia()).toBe(NK.SAVE_MEDIA_SDRAM);
  });

  it("reads the battery level the SDK allocates", async () => {
    await new Promise((r) => setTimeout(r, 50)); // let the mock's CapChange event (an owned pointer) arrive and be freed
    await worker.tick();
    expect(events.filter((e) => e.type === "status").at(-1)).toMatchObject({ detail: { battery: 60 } });
  });

  it("shoots, waits for the photo the SDK writes from its own thread, and moves it into place", async () => {
    const dest = path.join(dir, "captures", "nikon-a.jpg");
    await worker.capture(dest);
    expect(readFileSync(dest, "latin1")).toBe("\xff\xd8mock-nikon-photo-end");
    expect(mock.lastAutoFocus()).toBe(1);
    await waitFor(
      () => events.some((e) => e.type === "log" && e.message.includes("DSC_0001.JPG")),
      "the ImageSaved event's path"
    );
  });

  it("serves live-view frames pushed from the SDK's thread, then stops live view", async () => {
    worker.frame();
    let frame: Uint8Array | null = null;
    await waitFor(() => (frame = worker.frame()) !== null, "a live view frame");
    expect(Buffer.from(frame!).toString("latin1")).toMatch(/^\xff\xd8 frame \d+$/);
    // A shot while live view runs still works.
    await worker.capture(path.join(dir, "captures", "nikon-b.jpg"));
    // Live view stopping joins the SDK's frame thread; that must not deadlock.
    worker.frame();
  });

  it("reads the settings the SDK allocates: packed strings, an unsigned enum and a range", async () => {
    const settings = await worker.getSettings();
    expect(settings.mode).toBe("P");
    expect(settings.settings.iso.options.map((o) => o.label)).toEqual(["ISO 100", "ISO 200", "ISO 400", "ISO 800"]);
    expect(settings.settings.iso.value).toEqual({ code: 1, label: "ISO 200" });
    expect(settings.settings.av.value?.label).toBe("f/5.6");
    expect(settings.settings.tv.options).toHaveLength(3);
    expect(settings.settings.ev.options.map((o) => o.label)).toEqual(["-1.0", "-0.7", "-0.3", "0", "+0.3", "+0.7", "+1.0"]);
    expect(settings.settings.ev.value).toEqual({ code: 3, label: "0" });
  });

  it("sets an enum by index and a range by step, and reports what the camera refuses", async () => {
    const result = await worker.setSettings({ iso: 3, ev: 5, av: 0 });
    expect(mock.settingIndex(NK.CAP_SENSITIVITY)).toBe(3);
    expect(mock.settingIndex(NK.CAP_APERTURE)).toBe(0);
    expect(mock.evIndex()).toBe(5);
    expect(result.rejected).toEqual([]);
    expect(result.settings.iso.value?.label).toBe("ISO 800");
    expect(result.settings.ev.value?.label).toBe("+0.7");

    mock.refuseNextSet(NK.CAP_SHUTTER_SPEED);
    const refused = await worker.setSettings({ tv: 2, wb: 1, iso: 99 });
    expect(refused.rejected.sort()).toEqual(["iso", "tv"]); // tv: the SDK said no; iso: no such option
    expect(mock.settingIndex(NK.CAP_WB_MODE)).toBe(1);
  });

  it("notices the camera being unplugged through the SDK's event", async () => {
    mock.unplug();
    await waitFor(async () => {
      await worker.tick();
      return !worker.connected;
    }, "the disconnect");
    expect(events.at(-1)).toEqual({ type: "state", connected: false, model: null, serial: null });
  });
});
