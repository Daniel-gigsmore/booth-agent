import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NikonWorker } from "../src/camera/nikon/NikonWorker";
import { NK } from "../src/camera/nikon/nikonLayout";
import { applyNikonSettings, readNikonSettings } from "../src/camera/nikon/nikonSettings";
import { FakeNikon } from "./helpers/fakeNikon";
import { fakeClock } from "./helpers/fakeEdsdk";

describe("Nikon settings", () => {
  let nikon: FakeNikon;
  beforeEach(() => {
    nikon = new FakeNikon();
  });

  it("lists each setting's options and current value in the Canon's shape", async () => {
    const s = await readNikonSettings(nikon);
    expect(s.mode).toBe("M");
    expect(s.settings.iso).toEqual({
      value: { code: 1, label: "ISO 200" },
      options: [
        { code: 0, label: "ISO 100" },
        { code: 1, label: "ISO 200" },
        { code: 2, label: "ISO 400" },
      ],
    });
    expect(s.settings.av.value).toEqual({ code: 0, label: "f/3.5" });
    expect(s.rejected).toEqual([]);
  });

  it("spreads a stepped range over its steps and labels them in EV", async () => {
    const s = await readNikonSettings(nikon);
    expect(s.settings.ev.options.map((o) => o.label)).toEqual(["-0.6", "-0.3", "0", "+0.3", "+0.6"]);
    expect(s.settings.ev.value).toEqual({ code: 2, label: "0" });
  });

  it("shows a setting the camera doesn't offer as unavailable, not as an error", async () => {
    const s = await readNikonSettings(nikon);
    expect(s.settings.wb).toEqual({ value: null, options: [] });
    expect(s.settings.tv).toEqual({ value: null, options: [] });
    expect(s.settings.quality.options).toEqual([]);
  });

  it("can't list a continuous range, and says so with no options", async () => {
    nikon.ranges.set(NK.CAP_EXPOSURE_COMP, { value: 0.3, def: 0, valueIndex: 0, defaultIndex: 0, lower: -5, upper: 5, steps: 0 });
    expect((await readNikonSettings(nikon)).settings.ev).toEqual({ value: null, options: [] });
  });

  it("applies the changes and returns the settings as they are afterwards", async () => {
    const s = await applyNikonSettings(nikon, { iso: 2, av: 1, ev: 4 });
    expect(nikon.sets).toEqual([
      [NK.CAP_SENSITIVITY, 2],
      [NK.CAP_APERTURE, 1],
      [NK.CAP_EXPOSURE_COMP, 4],
    ]);
    expect(s.settings.iso.value?.label).toBe("ISO 400");
    expect(s.settings.ev.value?.label).toBe("+0.6");
    expect(s.rejected).toEqual([]);
  });

  it("rejects keys the camera doesn't offer, an index outside the list, and a set the SDK refuses - and still applies the rest", async () => {
    nikon.setErrors.set(NK.CAP_APERTURE, -104);
    const s = await applyNikonSettings(nikon, { wb: 0, iso: 7, ev: 9, av: 1, quality: 0 });
    expect([...s.rejected].sort()).toEqual(["av", "ev", "iso", "quality", "wb"]);
    expect(nikon.sets).toEqual([]);
    const ok = await applyNikonSettings(nikon, { iso: 0 });
    expect(ok.rejected).toEqual([]);
    expect(nikon.sets).toEqual([[NK.CAP_SENSITIVITY, 0]]);
  });

  it("fails the whole call when the camera has gone", async () => {
    nikon.readErr = -114;
    await expect(readNikonSettings(nikon)).rejects.toThrow(/Nikon disconnected \(DeviceNotAvailable/);
  });
});

describe("NikonWorker settings", () => {
  let nikon: FakeNikon;
  let worker: NikonWorker;
  const events: unknown[] = [];

  beforeEach(async () => {
    nikon = new FakeNikon();
    events.length = 0;
    worker = new NikonWorker(nikon, (e) => events.push(e), path.join(mkdtempSync(path.join(tmpdir(), "nikon-set-")), "d"), fakeClock(1_000_000));
    await worker.start();
  });

  it("refuses without a camera", async () => {
    await expect(worker.getSettings()).rejects.toThrow("No Nikon camera connected");
    await expect(worker.setSettings({ iso: 0 })).rejects.toThrow("No Nikon camera connected");
  });

  it("reads and sets once connected", async () => {
    await worker.tick();
    expect((await worker.getSettings()).settings.iso.value?.label).toBe("ISO 200");
    expect((await worker.setSettings({ iso: 0 })).settings.iso.value?.label).toBe("ISO 100");
  });

  it("drops the connection when a settings call finds the camera gone", async () => {
    await worker.tick();
    nikon.readErr = -114;
    await expect(worker.getSettings()).rejects.toThrow(/Nikon disconnected/);
    await Promise.resolve();
    expect(worker.connected).toBe(false);
  });
});
