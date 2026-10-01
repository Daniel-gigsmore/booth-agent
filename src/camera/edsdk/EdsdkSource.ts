import { fork } from "node:child_process";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";
import { CameraSource, CameraUnavailableError, CaptureResult } from "../CameraSource";
import type { CameraTarget } from "./CameraWorker";
import {
  CameraDetail,
  CameraSettings,
  isResponse,
  RequestBody,
  SettingChanges,
  SettingKey,
  WorkerMessage,
  WorkerRequest,
} from "./protocol";
import { createLogger } from "../../util/logger";

const log = createLogger("camera:edsdk");

const TIMEOUT_MS = { capture: 12_000, frame: 2_000, other: 3_000 } as const;
const PING_INTERVAL_MS = 2_000;
const MAX_MISSED_PINGS = 2;
const RESPAWN_BACKOFF_MS = [1_000, 2_000, 5_000] as const;
const SHUTDOWN_GRACE_MS = 3_000;
const APPLY_SAVED_RETRY_DELAY_MS = 1_500;
// How long initialize() waits for the worker's first connected/not-connected
// answer. Loading the DLL and the first scan take well under a second.
const FIRST_STATE_TIMEOUT_MS = 5_000;

/** The parts of ChildProcess EdsdkSource uses, so tests can hand it an in-process fake. */
export interface WorkerHandle {
  send(message: WorkerRequest): boolean;
  on(event: "message", listener: (message: WorkerMessage) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): boolean;
}

/** Forks the compiled worker with argv [dllPath, serial, avoid, minBodies] ("" = none). */
export function spawnWorker(dllPath: string, target: CameraTarget): WorkerHandle {
  const child = fork(path.join(__dirname, "worker.js"), [dllPath, target.serial ?? "", target.avoid ?? "", String(target.minBodies)], {
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

/** How a worker-driven camera names itself in errors and photo file names. */
export interface WorkerCameraLabel {
  /** "Canon" / "Nikon" */
  brand: string;
  /** Photo file name prefix: "canon" -> canon-<uuid>.jpg */
  filePrefix: string;
  /** Log category for the worker's messages. */
  logName: string;
}

const CANON: WorkerCameraLabel = { brand: "Canon", filePrefix: "canon", logName: "camera:edsdk" };

interface Pending {
  resolve: (result: Uint8Array | CameraSettings | null) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A camera driven through our own worker process: the Canon through EDSDK
 * (instead of digiCamControl), or the Nikon through its Remote SDK - both
 * workers speak the same protocol (protocol.ts). EDSDK's native code runs in the child so a crash or hang
 * there can't take down printing or sync; this class supervises it (pings,
 * respawn with backoff) and caches the connection state the worker pushes,
 * so isHealthy() is instant for CameraManager's 500 ms poll.
 */
export class EdsdkSource implements CameraSource {
  // "canon" is the agent's name for the tethered-camera kind (vs the webcam);
  // a Nikon in one of the slots reports it too.
  readonly kind = "canon" as const;

  private worker: WorkerHandle | null = null;
  private connected = false;
  private model: string | null = null;
  private serial: string | null = null;
  /** Set by restart(): the coming exit is ours, not a crash. */
  private restarting = false;
  private detail: CameraDetail | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private pingTimer: NodeJS.Timeout | undefined;
  private respawnTimer: NodeJS.Timeout | undefined;
  private missedPings = 0;
  private respawns = 0;
  private stopping = false;
  /** Captures waiting on the worker; a long AF hunt can block it from answering pings. */
  private capturesInFlight = 0;
  /** Resolves initialize() once the worker's first state arrives (or it exits). */
  private onFirstState: (() => void) | null = null;

  constructor(
    private readonly spawn: () => WorkerHandle,
    private readonly loadSaved: () => SettingChanges = () => ({}),
    private readonly label: WorkerCameraLabel = CANON
  ) {
    this.log = createLogger(label.logName);
  }

  private readonly log: ReturnType<typeof createLogger>;

  /**
   * Waits for the worker's first answer, so CameraManager doesn't start on
   * "no Canon" and flip to the Canon a moment later.
   */
  async initialize(): Promise<boolean> {
    const firstState = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FIRST_STATE_TIMEOUT_MS);
      this.onFirstState = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.start();
    this.pingTimer = setInterval(() => void this.ping(), PING_INTERVAL_MS);
    await firstState;
    this.onFirstState = null;
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

  getSerial(): string | null {
    return this.serial;
  }

  /**
   * Asks the worker to close its camera and exit, so the body is free for the other slot's
   * worker, and kills it if it hasn't gone within the grace period. onExit respawns it, and
   * the spawn function reads the slot's current serial.
   */
  restart(): void {
    const worker = this.worker;
    if (!worker || this.restarting) return;
    this.restarting = true;
    const timer = setTimeout(() => worker.kill(), SHUTDOWN_GRACE_MS);
    worker.on("exit", () => clearTimeout(timer));
    this.request({ type: "shutdown" }, SHUTDOWN_GRACE_MS).catch(() => undefined);
  }

  async capture(destDir: string): Promise<CaptureResult> {
    await mkdir(destDir, { recursive: true });
    const filePath = path.join(destDir, `${this.label.filePrefix}-${uuidv4()}.jpg`);
    this.capturesInFlight += 1;
    try {
      await this.request({ type: "capture", destPath: filePath }, TIMEOUT_MS.capture);
      const metadata = await sharp(filePath).metadata();
      if (!metadata.width || !metadata.height) {
        throw new Error(`${this.label.brand} capture produced an unreadable image: ${filePath}`);
      }
      return { filePath, width: metadata.width, height: metadata.height };
    } catch (err) {
      // A failed shot may still have left a partial or late file behind.
      await unlink(filePath).catch(() => undefined);
      throw err;
    } finally {
      this.capturesInFlight -= 1;
    }
  }

  /** Asks the worker to half-press now so focus is ready at zero. */
  async prefocus(): Promise<void> {
    await this.request({ type: "prefocus" }, TIMEOUT_MS.other);
  }

  async getLiveviewFrame(): Promise<Buffer | null> {
    if (!this.connected) return null;
    try {
      const frame = (await this.request({ type: "frame" }, TIMEOUT_MS.frame)) as Uint8Array | null;
      // Structured-clone IPC delivers a Uint8Array; the MJPEG writer wants a Buffer.
      return frame && frame.byteLength > 0 ? Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength) : null;
    } catch {
      return null;
    }
  }

  async getSettings(): Promise<CameraSettings> {
    if (!this.connected) throw new CameraUnavailableError(`No ${this.label.brand} camera connected`);
    return (await this.request({ type: "getSettings" }, TIMEOUT_MS.other)) as CameraSettings;
  }

  async setSettings(changes: SettingChanges): Promise<CameraSettings> {
    if (!this.connected) throw new CameraUnavailableError(`No ${this.label.brand} camera connected`);
    return (await this.request({ type: "setSettings", changes }, TIMEOUT_MS.other)) as CameraSettings;
  }

  /**
   * Re-applies the operator's saved settings after every (re)connect. EDSDK
   * fills its property-desc cache from events that arrive just after the
   * session opens, so an apply right on connect can get every key rejected
   * for no reason other than bad timing: if that happens, wait a moment for
   * the cache to catch up and try once more before giving up on any of them.
   */
  private async applySaved(): Promise<void> {
    try {
      const saved = this.loadSaved();
      const keys = Object.keys(saved) as SettingKey[];
      if (keys.length === 0) return;
      let result = await this.setSettings(saved);
      if (result.rejected.length === keys.length && this.connected && !this.stopping) {
        await new Promise((resolve) => setTimeout(resolve, APPLY_SAVED_RETRY_DELAY_MS));
        if (!this.connected || this.stopping) return;
        result = await this.setSettings(saved);
      }
      if (result.rejected.length) this.log.warn(`Camera refused saved settings in its current mode: ${result.rejected.join(", ")}`);
    } catch (err) {
      this.log.warn("Could not apply saved camera settings", err);
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
      this.onFirstState?.();
      this.connected = message.connected;
      this.model = message.model;
      this.serial = message.serial;
      if (message.connected) {
        this.respawns = 0;
        void this.applySaved();
      }
      return;
    }
    if (message.type === "status") {
      this.detail = { ...message.detail, lastError: message.detail.lastError ?? this.detail?.lastError ?? null };
      return;
    }
    this.log[message.level](message.message);
  }

  private onExit(worker: WorkerHandle, code: number | null): void {
    if (this.worker !== worker) return; // an old worker we already replaced
    this.worker = null;
    this.connected = false;
    this.onFirstState?.();
    const planned = this.restarting;
    this.restarting = false;
    this.serial = null;
    if (!this.stopping && !planned) {
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
    const delay = planned ? RESPAWN_BACKOFF_MS[0] : RESPAWN_BACKOFF_MS[Math.min(this.respawns, RESPAWN_BACKOFF_MS.length - 1)]!;
    if (!planned) this.respawns += 1;
    this.log[planned ? "info" : "warn"](`Camera worker exited (code ${String(code)}), restarting in ${delay} ms`);
    this.respawnTimer = setTimeout(() => this.start(), delay);
  }

  private async ping(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    try {
      await this.request({ type: "ping" }, PING_INTERVAL_MS);
      this.missedPings = 0;
    } catch {
      // The capture has its own timeout; a worker stuck in a long press isn't dead.
      if (this.capturesInFlight > 0) return;
      this.missedPings += 1;
      if (this.missedPings >= MAX_MISSED_PINGS && this.worker === worker) {
        this.log.warn("Camera worker stopped answering; killing it");
        worker.kill();
      }
    }
  }

  private request(body: RequestBody, timeoutMs: number): Promise<Uint8Array | CameraSettings | null> {
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
