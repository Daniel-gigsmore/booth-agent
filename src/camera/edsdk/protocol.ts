/** Messages between EdsdkSource (agent side) and the camera worker child process. */

import { SettingKey } from "./cameraLabels";
export type { SettingKey };

export interface SettingOption {
  code: number;
  label: string;
}

export interface CameraSettings {
  mode: string | null;
  settings: Record<SettingKey, { value: SettingOption | null; options: SettingOption[] }>;
  /** Keys from the last setSettings that the camera refused (not allowed in this mode, or the set failed). */
  rejected: SettingKey[];
}

export type SettingChanges = Partial<Record<SettingKey, number>>;

export type RequestBody =
  | { type: "capture"; destPath: string }
  | { type: "frame" }
  | { type: "prefocus" }
  | { type: "ping" }
  | { type: "shutdown" }
  | { type: "getSettings" }
  | { type: "setSettings"; changes: SettingChanges };

export type WorkerRequest = RequestBody & { id: number };

/** `result` is a JPEG for "frame" (or null when there is none right now), CameraSettings for get/setSettings, and null for everything else. */
export type WorkerResponse =
  | { id: number; ok: true; result: Uint8Array | CameraSettings | null }
  | { id: number; ok: false; error: string };

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Live camera detail for the Status tab / /health. Null fields mean "unknown right now". */
export interface CameraDetail {
  battery: number | "ac" | null;
  mode: string | null;
  afMode: string | null;
  quality: { label: string; hasJpeg: boolean } | null;
  lastError: { message: string; at: string } | null;
}

/** Pushed by the worker on its own, not in answer to a request. */
export type WorkerEvent =
  | { type: "state"; connected: boolean; model: string | null; serial: string | null }
  | { type: "log"; level: LogLevel; message: string }
  | { type: "status"; detail: CameraDetail };

export type WorkerMessage = WorkerResponse | WorkerEvent;

export const isResponse = (m: WorkerMessage): m is WorkerResponse => "id" in m;
