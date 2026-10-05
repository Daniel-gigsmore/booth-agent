import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { WorkerHandle } from "../src/camera/edsdk/EdsdkSource";
import { WorkerMessage, WorkerRequest } from "../src/camera/edsdk/protocol";
import { createNikonSource } from "../src/camera/nikon/NikonSource";
import { CameraUnavailableError } from "../src/camera/CameraSource";

/** Answers like the Nikon worker: connected Z 30, captures write a small JPEG. */
class FakeNikonWorker extends EventEmitter implements WorkerHandle {
  constructor(connected: boolean) {
    super();
    queueMicrotask(() =>
      this.emit("message", { type: "state", connected, model: connected ? "Nikon Z 30" : null, serial: null } satisfies WorkerMessage)
    );
  }
  send(req: WorkerRequest): boolean {
    void (async () => {
      if (req.type === "capture") {
        await sharp({ create: { width: 30, height: 20, channels: 3, background: "#555" } }).jpeg().toFile(req.destPath);
      }
      if (req.type === "shutdown") queueMicrotask(() => this.emit("exit", 0));
      this.emit("message", { id: req.id, ok: true, result: null } satisfies WorkerMessage);
    })();
    return true;
  }
  kill(): boolean {
    queueMicrotask(() => this.emit("exit", null));
    return true;
  }
}

describe("Nikon CameraSource", () => {
  it("captures to nikon-<uuid>.jpg through the shared worker supervisor", async () => {
    const source = createNikonSource("C:\\nikon", () => ({}), () => new FakeNikonWorker(true));
    expect(await source.initialize()).toBe(true);
    expect(source.getModel()).toBe("Nikon Z 30");
    const result = await source.capture(mkdtempSync(path.join(tmpdir(), "nikon-src-")));
    expect(path.basename(result.filePath)).toMatch(/^nikon-[0-9a-f-]{36}\.jpg$/);
    expect(result).toMatchObject({ width: 30, height: 20 });
    await source.shutdown();
  });

  it("names the brand when it isn't connected", async () => {
    const source = createNikonSource("C:\\nikon", () => ({}), () => new FakeNikonWorker(false));
    expect(await source.initialize()).toBe(false);
    await expect(source.getSettings()).rejects.toThrow(CameraUnavailableError);
    await expect(source.getSettings()).rejects.toThrow("No Nikon camera connected");
    await source.shutdown();
  });
});
