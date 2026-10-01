/**
 * Entry point of the Nikon camera worker child process (forked by
 * spawnNikonWorker with the SDK folder as argv[2]). Owns the only Nikon SDK
 * session on the machine. Speaks the same protocol as the Canon worker, so
 * the agent supervises both with the same EdsdkSource.
 */
import os from "node:os";
import path from "node:path";
import { NikonWorker } from "./NikonWorker";
import { loadNikon } from "./nikonNative";
import { installNxTetherConfig, nxTetherDir } from "./nxTetherConfig";
import { CameraSettings, RequestBody, WorkerMessage, WorkerRequest } from "../edsdk/protocol";
import { AsyncMutex } from "../../util/mutex";

const TICK_MS = 100;

const [sdkDir] = process.argv.slice(2);
if (!sdkDir || !process.send) {
  console.error("nikon worker: must be forked by the agent with the Nikon SDK folder");
  process.exit(2);
}

const send = (message: WorkerMessage): void => {
  process.send?.(message);
};
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const profiles = nxTetherDir();
if (profiles) {
  try {
    const { copied, missing } = installNxTetherConfig(sdkDir, profiles);
    if (copied.length) send({ type: "log", level: "info", message: `Installed Nikon SDK profiles into ${profiles}: ${copied.join(", ")}` });
    if (missing.length) send({ type: "log", level: "warn", message: `Nikon SDK folder ${sdkDir} is missing ${missing.join(", ")}` });
  } catch (err) {
    send({ type: "log", level: "warn", message: `Could not install the Nikon SDK profiles into ${profiles}: ${errorText(err)}` });
  }
}

let worker: NikonWorker;
try {
  worker = new NikonWorker(loadNikon(sdkDir), send, path.join(os.tmpdir(), "booth-agent-nikon"));
} catch (err) {
  // Usually ControlServiceLayer.dll missing, or the VC++ 2022 runtime it needs isn't installed.
  send({ type: "log", level: "error", message: `Could not load the Nikon SDK from ${sdkDir}: ${errorText(err)}` });
  process.exit(3);
}

const captureLock = new AsyncMutex();
let stopping = false;

async function loop(): Promise<void> {
  while (!stopping) {
    try {
      await worker.tick();
    } catch (err) {
      send({ type: "log", level: "error", message: `tick failed: ${errorText(err)}` });
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
}

let stopped: Promise<never> | null = null;
function stop(): Promise<never> {
  stopped ??= shutdownAndExit();
  return stopped;
}

async function shutdownAndExit(): Promise<never> {
  stopping = true;
  // Never hang on a wedged SDK: the agent kills us after its grace period anyway.
  await Promise.race([worker.shutdown(), new Promise((resolve) => setTimeout(resolve, 2_000))]).catch(() => undefined);
  process.exit(0);
}

async function handle(request: RequestBody): Promise<Uint8Array | CameraSettings | null> {
  switch (request.type) {
    case "capture":
      await captureLock.run(() => worker.capture(request.destPath));
      return null;
    case "frame":
      return worker.frame();
    case "prefocus":
      // The shot itself autofocuses; there is no separate half-press here.
      return null;
    case "ping":
      return null;
    case "shutdown":
      setImmediate(() => void stop()); // answer first, then exit
      return null;
    case "getSettings":
    case "setSettings":
      return worker.getSettings();
  }
}

process.on("message", (request: WorkerRequest) => {
  handle(request).then(
    (result) => send({ id: request.id, ok: true, result }),
    (err: unknown) => send({ id: request.id, ok: false, error: errorText(err) })
  );
});

// The agent went away without saying goodbye: release the camera anyway.
process.on("disconnect", () => void stop());

worker.start().then(
  () => void loop(),
  (err: unknown) => {
    send({ type: "log", level: "error", message: errorText(err) });
    process.exit(3);
  }
);
