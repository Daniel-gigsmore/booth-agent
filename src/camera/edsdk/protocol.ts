/** Messages between EdsdkSource (agent side) and the camera worker child process. */

export type RequestBody =
  | { type: "capture"; destPath: string }
  | { type: "frame" }
  | { type: "ping" }
  | { type: "shutdown" };

export type WorkerRequest = RequestBody & { id: number };

/** `result` is a JPEG for "frame" (or null when there is none right now) and null for everything else. */
export type WorkerResponse =
  | { id: number; ok: true; result: Uint8Array | null }
  | { id: number; ok: false; error: string };

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Pushed by the worker on its own, not in answer to a request. */
export type WorkerEvent =
  | { type: "state"; connected: boolean; model: string | null }
  | { type: "log"; level: LogLevel; message: string };

export type WorkerMessage = WorkerResponse | WorkerEvent;

export const isResponse = (m: WorkerMessage): m is WorkerResponse => "id" in m;
