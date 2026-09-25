import { fork } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";
import { CameraSource, CaptureResult } from "../CameraSource";
import { CameraDetail, isResponse, RequestBody, WorkerMessage, WorkerRequest } from "./protocol";
import { createLogger } from "../../util/logger";

const log = createLogger("camera:edsdk");

const TIMEOUT_MS = { capture: 12_000, frame: 2_000, other: 3_000 } as const;
const PING_INTERVAL_MS = 2_000;
const MAX_MISSED_PINGS = 2;
const RESPAWN_BACKOFF_MS = [1_000, 2_000, 5_000] as const;
const SHUTDOWN_GRACE_MS = 3_000;

/** The parts of ChildProcess EdsdkSource uses, so tests can hand it an in-process fake. */
export interface WorkerHandle {
  send(message: WorkerRequest): boolean;
  on(event: "message", listener: (message: WorkerMessage) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): boolean;
}

/** Forks the compiled worker (dist/camera/edsdk/worker.js) with the DLL path as its only argument. */
export function spawnWorker(dllPath: string): WorkerHandle {
  const child = fork(path.join(__dirname, "worker.js"), [dllPath], {
    serialization: "advanced", // lets photos and frames cross as binary, not JSON
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  // Without this listener, an IPC send() into a channel that's already
  // closing (the gap between the worker dying and its 'exit' firing) makes
  // Node emit 'error' on the ChildProcess with no listener - an uncaught
  // exception that kills the whole agent.
  child.on("error", (err) => log.warn("Camera worker process error", err));
  return child as unknown as WorkerHandle;
}

interface Pending {
  resolve: (result: Uint8Array | null) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The Canon, driven through our own EDSDK worker process instead of
 * digiCamControl. EDSDK's native code runs in the child so a crash or hang
 * there can't take down printing or sync; this class supervises it (pings,
 * respawn with backoff) and caches the connection state the worker pushes,
 * so isHealthy() is instant for CameraManager's 500 ms poll.
 */
export class EdsdkSource implements CameraSource {
  readonly kind = "canon" as const;

  private worker: WorkerHandle | null = null;
  private connected = false;
  private model: string | null = null;
  private detail: CameraDetail | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private pingTimer: NodeJS.Timeout | undefined;
  private respawnTimer: NodeJS.Timeout | undefined;
  private missedPings = 0;
  private respawns = 0;
  private stopping = false;

  constructor(private readonly spawn: () => WorkerHandle) {}

  async initialize(): Promise<boolean> {
    this.start();
    this.pingTimer = setInterval(() => void this.ping(), PING_INTERVAL_MS);
    return this.connected;
  }

  async isHealthy(): Promise<boolean> {
    return this.worker !== null && this.connected;
  }

  getModel(): string | null {
    return this.model;
  }

  getDetail(): CameraDetail | null {
    return this.detail;
  }

  async capture(destDir: string): Promise<CaptureResult> {
    await mkdir(destDir, { recursive: true });
    const filePath = path.join(destDir, `canon-${uuidv4()}.jpg`);
    await this.request({ type: "capture", destPath: filePath }, TIMEOUT_MS.capture);
    const metadata = await sharp(filePath).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error(`Canon capture produced an unreadable image: ${filePath}`);
    }
    return { filePath, width: metadata.width, height: metadata.height };
  }

  /** Asks the worker to half-press now so focus is ready at zero. */
  async prefocus(): Promise<void> {
    await this.request({ type: "prefocus" }, TIMEOUT_MS.other);
  }

  async getLiveviewFrame(): Promise<Buffer | null> {
    if (!this.connected) return null;
    try {
      const frame = await this.request({ type: "frame" }, TIMEOUT_MS.frame);
      // Structured-clone IPC delivers a Uint8Array; the MJPEG writer wants a Buffer.
      return frame && frame.byteLength > 0 ? Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength) : null;
    } catch {
      return null;
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.respawnTimer);
    const worker = this.worker;
    if (!worker) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        worker.kill();
        resolve();
      }, SHUTDOWN_GRACE_MS);
      worker.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.request({ type: "shutdown" }, SHUTDOWN_GRACE_MS).catch(() => undefined);
    });
  }

  private start(): void {
    const worker = this.spawn();
    this.worker = worker;
    this.missedPings = 0;
    worker.on("message", (message) => this.onMessage(message));
    worker.on("exit", (code) => this.onExit(worker, code));
  }

  private onMessage(message: WorkerMessage): void {
    if (isResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error));
      return;
    }
    if (message.type === "state") {
      this.connected = message.connected;
      this.model = message.model;
      if (message.connected) this.respawns = 0;
      return;
    }
    if (message.type === "status") {
      this.detail = { ...message.detail, lastError: message.detail.lastError ?? this.detail?.lastError ?? null };
      return;
    }
    log[message.level](message.message);
  }

  private onExit(worker: WorkerHandle, code: number | null): void {
    if (this.worker !== worker) return; // an old worker we already replaced
    this.worker = null;
    this.connected = false;
    if (!this.stopping) {
      this.detail = {
        battery: null, mode: null, afMode: null, quality: null,
        lastError: { message: `Camera worker exited (code ${String(code)})`, at: new Date().toISOString() },
      };
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Camera worker exited (code ${String(code)})`));
      this.pending.delete(id);
    }
    if (this.stopping) return;
    const delay = RESPAWN_BACKOFF_MS[Math.min(this.respawns, RESPAWN_BACKOFF_MS.length - 1)]!;
    this.respawns += 1;
    log.warn(`Camera worker exited (code ${String(code)}), restarting in ${delay} ms`);
    this.respawnTimer = setTimeout(() => this.start(), delay);
  }

  private async ping(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    try {
      await this.request({ type: "ping" }, PING_INTERVAL_MS);
      this.missedPings = 0;
    } catch {
      this.missedPings += 1;
      if (this.missedPings >= MAX_MISSED_PINGS && this.worker === worker) {
        log.warn("Camera worker stopped answering; killing it");
        worker.kill();
      }
    }
  }

  private request(body: RequestBody, timeoutMs: number): Promise<Uint8Array | null> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("Camera worker is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Camera worker timed out on ${body.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // send() returns false when the channel is already gone (worker died,
      // 'exit' just hasn't fired yet): fail this request now instead of
      // waiting out the timeout.
      if (!worker.send({ ...body, id })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("Camera worker channel is closed"));
      }
    });
  }
}
