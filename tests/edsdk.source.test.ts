import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { EdsdkSource, WorkerHandle } from "../src/camera/edsdk/EdsdkSource";
import { WorkerMessage, WorkerRequest } from "../src/camera/edsdk/protocol";

/** In-process stand-in for the worker child process. `reply` decides how each request is answered. */
class FakeWorker extends EventEmitter implements WorkerHandle {
  sent: WorkerRequest[] = [];
  killed = false;
  /** When false, send() reports the channel as closed instead of delivering the request. */
  sendOk = true;
  reply: (req: WorkerRequest) => WorkerMessage | Promise<WorkerMessage> | null = (req) => ({ id: req.id, ok: true, result: null });

  send(req: WorkerRequest): boolean {
    if (!this.sendOk) return false;
    this.sent.push(req);
    void Promise.resolve(this.reply(req)).then((m) => m && this.emit("message", m));
    return true;
  }
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null));
    return true;
  }
  push(m: WorkerMessage): void {
    this.emit("message", m);
  }
}

let workers: FakeWorker[];
let source: EdsdkSource;
const current = () => workers.at(-1)!;

beforeEach(async () => {
  vi.useFakeTimers();
  workers = [];
  source = new EdsdkSource(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  await source.initialize();
});

afterEach(async () => {
  current().reply = (req) => {
    if (req.type === "shutdown") queueMicrotask(() => current().emit("exit", 0));
    return { id: req.id, ok: true, result: null };
  };
  await source.shutdown();
  vi.useRealTimers();
});

describe("EdsdkSource", () => {
  it("is healthy only once the worker reports a connected camera", async () => {
    expect(await source.isHealthy()).toBe(false);
    current().push({ type: "state", connected: true, model: "Canon EOS R100" });
    expect(await source.isHealthy()).toBe(true);
    expect(source.getModel()).toBe("Canon EOS R100");
  });

  it("returns live view frames as Buffers, and null when the request times out", async () => {
    current().push({ type: "state", connected: true, model: "Canon EOS R100" });
    current().reply = (req) => ({ id: req.id, ok: true, result: new Uint8Array([0xff, 0xd8]) });
    const frame = await source.getLiveviewFrame();
    expect(Buffer.isBuffer(frame)).toBe(true);
    expect(frame).toEqual(Buffer.from([0xff, 0xd8]));

    current().reply = () => null; // never answers
    const pending = source.getLiveviewFrame();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toBeNull();
  });

  it("captures to canon-<uuid>.jpg in destDir and reports its size", async () => {
    vi.useRealTimers(); // sharp does real I/O
    current().push({ type: "state", connected: true, model: "Canon EOS R100" });
    current().reply = async (req) => {
      if (req.type === "capture") {
        await sharp({ create: { width: 30, height: 20, channels: 3, background: "#888" } }).jpeg().toFile(req.destPath);
      }
      return { id: req.id, ok: true, result: null };
    };
    const dir = mkdtempSync(path.join(tmpdir(), "edsdk-src-"));
    const result = await source.capture(dir);
    expect(path.dirname(result.filePath)).toBe(dir);
    expect(path.basename(result.filePath)).toMatch(/^canon-.+\.jpg$/);
    expect(result).toMatchObject({ width: 30, height: 20 });
    vi.useFakeTimers();
  });

  it("passes the worker's capture error through", async () => {
    current().reply = (req) => ({ id: req.id, ok: false, error: "Canon shutter failed: 0x2A" });
    await expect(source.capture(mkdtempSync(path.join(tmpdir(), "edsdk-src-")))).rejects.toThrow("0x2A");
  });

  it("respawns a crashed worker with 1 s, 2 s, 5 s, 5 s backoff", async () => {
    for (const delay of [1_000, 2_000, 5_000, 5_000]) {
      const before = workers.length;
      current().emit("exit", 1);
      expect(await source.isHealthy()).toBe(false);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(workers.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(workers.length).toBe(before + 1);
    }
  });

  it("resets the backoff once a respawned worker connects", async () => {
    current().emit("exit", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    current().push({ type: "state", connected: true, model: "Canon EOS R100" });
    current().emit("exit", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(workers.length).toBe(3);
  });

  it("fails fast, without waiting for the timeout, when send() reports the channel closed", async () => {
    current().push({ type: "state", connected: true, model: "Canon EOS R100" });
    current().sendOk = false;
    await expect(source.getLiveviewFrame()).resolves.toBeNull();
    await expect(source.capture(mkdtempSync(path.join(tmpdir(), "edsdk-src-")))).rejects.toThrow(
      "channel is closed"
    );
    current().sendOk = true; // let afterEach's shutdown() request reach the worker
  });

  it("rejects in-flight requests when the worker dies", async () => {
    current().reply = () => null;
    const pending = source.capture(mkdtempSync(path.join(tmpdir(), "edsdk-src-")));
    const assertion = expect(pending).rejects.toThrow("exited");
    // capture() awaits a real mkdir first; wait until the request has actually reached the worker.
    await vi.waitFor(() => expect(current().sent.some((r) => r.type === "capture")).toBe(true));
    current().emit("exit", 1);
    await assertion;
  });

  it("kills a worker that misses two pings, then respawns it", async () => {
    current().reply = () => null;
    const hung = current();
    await vi.advanceTimersByTimeAsync(2_000 + 2_000); // first ping times out
    expect(hung.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000); // second ping times out
    expect(hung.killed).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(current()).not.toBe(hung);
  });

  it("does not respawn after shutdown, and force-kills a worker that won't exit", async () => {
    current().reply = () => null;
    const stuck = current();
    const done = source.shutdown();
    await vi.advanceTimersByTimeAsync(3_000);
    await done;
    expect(stuck.killed).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(workers.length).toBe(1);
  });
});

describe("EdsdkSource detail", () => {
  it("caches the worker's status and keeps lastError when the worker dies", async () => {
    expect(source.getDetail()).toBeNull();
    const detail = { battery: "ac" as const, mode: "M", afMode: "AI Servo", quality: { label: "JPEG", hasJpeg: true }, lastError: null };
    current().push({ type: "status", detail });
    expect(source.getDetail()).toEqual(detail);

    current().emit("exit", 3);
    expect(source.getDetail()).toMatchObject({
      battery: null, mode: null, afMode: null, quality: null,
      lastError: { message: "Camera worker exited (code 3)" },
    });
  });

  it("preserves lastError when respawned worker sends status with lastError: null", async () => {
    // Crash the current worker
    current().emit("exit", 3);

    // Advance timers to allow respawn (1000ms backoff)
    await vi.advanceTimersByTimeAsync(1_000);

    // New worker sends status with lastError: null and battery 50
    const newDetail = {
      battery: 50 as const,
      mode: null,
      afMode: null,
      quality: null,
      lastError: null,
    };
    current().push({ type: "status", detail: newDetail });

    // Should preserve the crash error while updating battery
    const detail = source.getDetail();
    expect(detail).toEqual({
      battery: 50,
      mode: null,
      afMode: null,
      quality: null,
      lastError: { message: "Camera worker exited (code 3)", at: expect.any(String) },
    });

    // New error from worker should replace the old one
    const newError = { message: "Autofocus failed - took the shot without autofocus", at: "t" };
    current().push({ type: "status", detail: { ...newDetail, lastError: newError } });

    expect(source.getDetail()).toEqual({
      battery: 50,
      mode: null,
      afMode: null,
      quality: null,
      lastError: newError,
    });
  });
});

describe("EdsdkSource pre-focus", () => {
  it("sends a prefocus request to the worker", async () => {
    await source.prefocus();
    expect(current().sent.some((r) => r.type === "prefocus")).toBe(true);
  });
});
