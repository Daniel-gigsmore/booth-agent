export type CameraKind = "canon" | "webcam" | "none";

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

export interface CameraDisconnectedEvent {
  type: "camera-disconnected";
  source: CameraKind;
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
