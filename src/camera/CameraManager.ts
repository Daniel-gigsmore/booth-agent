import { CameraSource, CameraUnavailableError, CaptureResult } from "./CameraSource";
import { CameraKind, CameraSlot, CaptureCamera } from "../events/types";
import { CaptureSourcePreference } from "../config/schema";
import { EventBus } from "../events/eventBus";
import { createLogger } from "../util/logger";
import { CameraDetail, CameraSettings, SettingChanges } from "./edsdk/protocol";

const log = createLogger("camera:manager");

/**
 * Consecutive failed/succeeded health polls required before switching sources.
 * With the default 500ms poll interval and each source's health check capped
 * at ~1s, worst case detection is well under the 3s fallback SLA while still
 * ignoring a single blipped poll.
 */
const SWITCH_DEBOUNCE_TICKS = 2;

export interface CameraManagerStatus {
  activeSource: CameraKind;
  activeModel: string | null;
  canonConnected: boolean;
  webcamConnected: boolean;
  preference: CaptureSourcePreference;
  canonDetail: CameraDetail | null;
  canonModel: string | null;
  canonSerial: string | null;
  /** Null when there is no low camera slot (digiCamControl driver). */
  low: { connected: boolean; model: string | null; serial: string | null; detail: CameraDetail | null } | null;
}

/**
 * Owns both CameraSource instances, polls their health, and decides which one
 * is "active" - the only camera-specific decision the rest of the app needs
 * to know about. Capture and live-view calls are always routed through
 * whichever source is currently active, so a Canon disconnect mid-session is
 * invisible to callers beyond a camera-fallback event and a brief blip.
 */
export class CameraManager {
  private sources: Record<Exclude<CameraKind, "none">, CameraSource>;
  private preference: CaptureSourcePreference;
  private active: CameraKind = "none";
  private healthy: Record<Exclude<CameraKind, "none">, boolean> = {
    canon: false,
    webcam: false,
  };
  private consecutive: Record<Exclude<CameraKind, "none">, number> = {
    canon: 0,
    webcam: 0,
  };
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly pollIntervalMs: number;
  /** The second Canon (EDSDK only). Not part of the high/webcam active-source logic. */
  private readonly low: CameraSource | null;
  private lowHealthy = false;
  private lowConsecutive = 0;

  constructor(
    sources: { canon: CameraSource; webcam: CameraSource; canonLow?: CameraSource },
    preference: CaptureSourcePreference,
    private readonly eventBus: EventBus,
    pollIntervalMs = 500
  ) {
    this.sources = { canon: sources.canon, webcam: sources.webcam };
    this.low = sources.canonLow ?? null;
    this.preference = preference;
    this.pollIntervalMs = pollIntervalMs;
  }

  async start(): Promise<void> {
    const [canonOk, webcamOk, lowOk] = await Promise.all([
      this.sources.canon.initialize().catch(() => false),
      this.sources.webcam.initialize().catch(() => false),
      this.low ? this.low.initialize().catch(() => false) : Promise.resolve(false),
    ]);
    this.healthy.canon = canonOk;
    this.healthy.webcam = webcamOk;
    this.lowHealthy = lowOk;
    this.active = this.pickInitialActive();
    log.info(`Camera manager started, active source: ${this.active}`, {
      canonOk,
      webcamOk,
    });
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    await Promise.all([this.sources.canon.shutdown(), this.sources.webcam.shutdown(), this.low?.shutdown()]);
  }

  /** Applies a config reload's new preference without restarting the manager. */
  setPreference(preference: CaptureSourcePreference): void {
    if (this.preference === preference) return;
    this.preference = preference;
    log.info(`Capture source preference changed to ${preference}`);
    this.reconcileActive();
  }

  getStatus(): CameraManagerStatus {
    return {
      activeSource: this.active,
      activeModel: this.active === "none" ? null : this.sources[this.active].getModel(),
      canonConnected: this.healthy.canon,
      webcamConnected: this.healthy.webcam,
      preference: this.preference,
      canonDetail: this.sources.canon.getDetail?.() ?? null,
      canonModel: this.sources.canon.getModel(),
      canonSerial: this.sources.canon.getSerial?.() ?? null,
      low: this.low
        ? { connected: this.lowHealthy, model: this.low.getModel(), serial: this.low.getSerial?.() ?? null, detail: this.low.getDetail?.() ?? null }
        : null,
    };
  }

  /** Today's high-camera capture, unchanged: try the active source, retry once on fallback. */
  private async captureHigh(destDir: string): Promise<CaptureResult & { source: CameraKind }> {
    if (this.active === "none") {
      throw new Error("No capture source is available");
    }
    const primaryKind = this.active;
    try {
      const result = await this.sources[primaryKind].capture(destDir);
      return { ...result, source: primaryKind };
    } catch (err) {
      log.warn(`Capture failed on ${primaryKind}, marking unhealthy and retrying on fallback`, err);
      this.healthy[primaryKind] = false;
      this.consecutive[primaryKind] = 0;
      this.reconcileActive();
      const currentActive = this.active as CameraKind;
      if (currentActive === "none" || currentActive === primaryKind) {
        throw err;
      }
      const fallbackKind = currentActive;
      const result = await this.sources[fallbackKind].capture(destDir);
      return { ...result, source: fallbackKind };
    }
  }

  /**
   * A photo on `camera`, falling back to the other Canon, then the webcam, so
   * a guest always gets a picture. `camera` in the result says what took it.
   */
  async capture(destDir: string, camera: CameraSlot = "high"): Promise<CaptureResult & { source: CameraKind; camera: CaptureCamera }> {
    if (camera === "high" && !this.healthy.canon && this.low && this.lowHealthy) {
      try {
        return { ...(await this.low.capture(destDir)), source: "canon", camera: "low" };
      } catch (err) {
        log.warn("The high camera is down and the low one failed too, marking it unhealthy", err);
        this.lowHealthy = false;
        this.lowConsecutive = 0;
      }
    } else if (camera === "low" && this.low && this.lowHealthy) {
      try {
        return { ...(await this.low.capture(destDir)), source: "canon", camera: "low" };
      } catch (err) {
        log.warn("Capture failed on the low camera, marking it unhealthy and using the high one", err);
        this.lowHealthy = false;
        this.lowConsecutive = 0;
      }
    } else if (camera === "low") {
      log.warn("The low camera isn't available - taking this photo with the high one");
    }
    const result = await this.captureHigh(destDir);
    return { ...result, camera: result.source === "canon" ? "high" : "webcam" };
  }

  /** The operator's test shot: exactly this camera, or CameraUnavailableError. */
  async captureExact(destDir: string, camera: CameraSlot): Promise<CaptureResult & { source: CameraKind; camera: CaptureCamera }> {
    const source = this.canonSlot(camera);
    const up = camera === "low" ? this.lowHealthy : this.healthy.canon;
    if (!up) throw new CameraUnavailableError(`The ${camera} camera is not connected`);
    return { ...(await source.capture(destDir)), source: "canon", camera };
  }

  /** The source a live view or pre-focus for `camera` should use: whatever its capture would. */
  private routed(camera: CameraSlot): { source: CameraSource; kind: CameraKind } | null {
    if (this.low && this.lowHealthy && (camera === "low" || !this.healthy.canon)) return { source: this.low, kind: "canon" };
    if (this.active === "none") return null;
    return { source: this.sources[this.active], kind: this.active };
  }

  private canonSlot(camera: CameraSlot): CameraSource {
    if (camera === "high") return this.sources.canon;
    if (!this.low) throw new CameraUnavailableError("A low camera needs the EDSDK driver");
    return this.low;
  }

  /** After cameras.json changed: both workers re-open with their slot's serial. */
  restartCanonWorkers(): void {
    this.sources.canon.restart?.();
    this.low?.restart?.();
  }

  /** Best-effort: never rejects, since the capture works the same without it. */
  async prefocus(camera: CameraSlot = "high"): Promise<void> {
    const r = this.routed(camera);
    if (!r) return;
    try {
      await r.source.prefocus?.();
    } catch (err) {
      log.debug(`Pre-focus failed on ${camera}`, err);
    }
  }

  async getLiveviewFrame(camera: CameraSlot = "high"): Promise<{ frame: Buffer; source: CameraKind } | null> {
    const r = this.routed(camera);
    if (!r) return null;
    const frame = await r.source.getLiveviewFrame();
    return frame ? { frame, source: r.kind } : null;
  }

  /** Operator-panel camera settings; only a source with settings support (EDSDK) can do this. */
  async getCanonSettings(camera: CameraSlot = "high"): Promise<CameraSettings> {
    const source = this.canonSlot(camera);
    if (!source.getSettings) throw new CameraUnavailableError("Camera settings need the EDSDK driver");
    return source.getSettings();
  }

  async setCanonSettings(changes: SettingChanges, camera: CameraSlot = "high"): Promise<CameraSettings> {
    const source = this.canonSlot(camera);
    if (!source.setSettings) throw new CameraUnavailableError("Camera settings need the EDSDK driver");
    return source.setSettings(changes);
  }

  private pickInitialActive(): CameraKind {
    if (this.healthy[this.preference]) return this.preference;
    const other = this.otherKind(this.preference);
    if (this.healthy[other]) return other;
    return "none";
  }

  private otherKind(kind: Exclude<CameraKind, "none">): Exclude<CameraKind, "none"> {
    return kind === "canon" ? "webcam" : "canon";
  }

  private async pollOnce(): Promise<void> {
    const kinds: Array<Exclude<CameraKind, "none">> = ["canon", "webcam"];
    await Promise.all(
      kinds.map(async (kind) => {
        const wasHealthy = this.healthy[kind];
        const isHealthy = await this.sources[kind].isHealthy().catch(() => false);
        if (isHealthy === wasHealthy) {
          this.consecutive[kind] = 0;
          return;
        }
        this.consecutive[kind] += 1;
        if (this.consecutive[kind] >= SWITCH_DEBOUNCE_TICKS) {
          this.healthy[kind] = isHealthy;
          this.consecutive[kind] = 0;
          const slot = kind === "canon" ? { camera: "high" as const } : {};
          if (!isHealthy && this.active === kind) {
            this.eventBus.emit({ type: "camera-disconnected", source: kind, ...slot });
          }
          if (isHealthy) {
            this.eventBus.emit({ type: "camera-recovered", source: kind, ...slot });
          }
          this.reconcileActive();
        }
      })
    );
    if (this.low) {
      const isHealthy = await this.low.isHealthy().catch(() => false);
      if (isHealthy === this.lowHealthy) {
        this.lowConsecutive = 0;
      } else if (++this.lowConsecutive >= SWITCH_DEBOUNCE_TICKS) {
        this.lowHealthy = isHealthy;
        this.lowConsecutive = 0;
        log[isHealthy ? "info" : "warn"](`Low camera ${isHealthy ? "connected" : "disconnected"}`);
        this.eventBus.emit({ type: isHealthy ? "camera-recovered" : "camera-disconnected", source: "canon", camera: "low" });
      }
    }
  }

  private reconcileActive(): void {
    const desired = this.pickInitialActive();
    if (desired === this.active) return;
    const previous = this.active;
    this.active = desired;
    log.info(`Active camera source changed: ${previous} -> ${desired}`);
    if (desired !== "none" && previous !== "none") {
      this.eventBus.emit({
        type: "camera-fallback",
        from: previous,
        to: desired,
        reason:
          desired === this.preference
            ? `${this.preference} reconnected`
            : `${previous} became unavailable`,
      });
    }
  }
}
