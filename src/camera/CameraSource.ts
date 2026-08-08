import { CameraKind } from "../events/types";

export interface CaptureResult {
  filePath: string;
  width: number;
  height: number;
}

/**
 * Contract every physical capture device must satisfy. The camera manager
 * only ever talks to this interface, never to a concrete device — adding a
 * third camera later means writing one new class that implements this and
 * registering it in CameraManager's source map, nothing else changes.
 */
export interface CameraSource {
  readonly kind: CameraKind;

  /** Attempt to bring the device online. Returns true if usable now. */
  initialize(): Promise<boolean>;

  /** Release any resources (child processes, sockets). Safe to call when never initialized. */
  shutdown(): Promise<void>;

  /** Cheap, fast liveness check used by the poll loop (must resolve within a couple seconds). */
  isHealthy(): Promise<boolean>;

  /** Capture a full-resolution still into destDir and return its path + dimensions. */
  capture(destDir: string): Promise<CaptureResult>;

  /** Return a single current live-view JPEG frame, or null if unavailable right now. */
  getLiveviewFrame(): Promise<Buffer | null>;

  /** Best-effort human-readable model/device name for /health, from the last health check. */
  getModel(): string | null;
}
