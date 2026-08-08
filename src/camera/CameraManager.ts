import { CameraSource, CaptureResult } from "./CameraSource";
import { CameraKind } from "../events/types";
import { CaptureSourcePreference } from "../config/schema";
import { EventBus } from "../events/eventBus";
import { createLogger } from "../util/logger";

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

  constructor(
    sources: { canon: CameraSource; webcam: CameraSource },
    preference: CaptureSourcePreference,
    private readonly eventBus: EventBus,
    pollIntervalMs = 500
  ) {
    this.sources = sources;
    this.preference = preference;
    this.pollIntervalMs = pollIntervalMs;
  }

  async start(): Promise<void> {
    const [canonOk, webcamOk] = await Promise.all([
      this.sources.canon.initialize().catch(() => false),
      this.sources.webcam.initialize().catch(() => false),
    ]);
    this.healthy.canon = canonOk;
    this.healthy.webcam = webcamOk;
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
    await Promise.all([this.sources.canon.shutdown(), this.sources.webcam.shutdown()]);
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
    };
  }

  async capture(destDir: string): Promise<CaptureResult & { source: CameraKind }> {
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

  async getLiveviewFrame(): Promise<{ frame: Buffer; source: CameraKind } | null> {
    if (this.active === "none") return null;
    const frame = await this.sources[this.active].getLiveviewFrame();
    if (!frame) return null;
    return { frame, source: this.active };
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
          if (!isHealthy && this.active === kind) {
            this.eventBus.emit({ type: "camera-disconnected", source: kind });
          }
          if (isHealthy) {
            this.eventBus.emit({ type: "camera-recovered", source: kind });
          }
          this.reconcileActive();
        }
      })
    );
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
