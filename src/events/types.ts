export type CameraKind = "canon" | "webcam" | "none";

/** Which of the booth's two Canons: mounted high looking down, or low looking up. */
export type CameraSlot = "high" | "low";
/** What actually took a photo: one of the Canon slots, or the webcam fallback. */
export type CaptureCamera = CameraSlot | "webcam";

export interface CaptureTakenEvent {
  type: "capture-taken";
  captureId: string;
  filePath: string;
  source: CameraKind;
  takenAt: string;
}

export interface SyncStatusEvent {
  type: "sync-status";
  queueDepth: number;
  lastSyncAt: string | null;
  lastError: string | null;
  /** Captures given up on. Not part of queueDepth - they need a human, not time. */
  abandonedCount: number;
  online: boolean;
}

export interface PrintQueuedEvent {
  type: "print-queued";
  jobId: string;
  size: "4x6" | "2x6-strip";
  queuePosition: number;
  estimatedWaitMs: number;
}

export interface PrintCompletedEvent {
  type: "print-completed";
  jobId: string;
}

/** `camera` says which Canon (high or low) for a Canon source; absent for the webcam. */
export interface CameraDisconnectedEvent {
  type: "camera-disconnected";
  source: CameraKind;
  camera?: CameraSlot;
}

export interface CameraFallbackEvent {
  type: "camera-fallback";
  from: CameraKind;
  to: CameraKind;
  reason: string;
}

export interface CameraRecoveredEvent {
  type: "camera-recovered";
  source: CameraKind;
  camera?: CameraSlot;
}

export interface ErrorEvent {
  type: "error";
  scope: string;
  message: string;
}

export type BoothEvent =
  | CaptureTakenEvent
  | SyncStatusEvent
  | PrintQueuedEvent
  | PrintCompletedEvent
  | CameraDisconnectedEvent
  | CameraFallbackEvent
  | CameraRecoveredEvent
  | ErrorEvent;
