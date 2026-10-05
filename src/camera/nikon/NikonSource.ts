import { fork } from "node:child_process";
import path from "node:path";
import { EdsdkSource, WorkerHandle } from "../edsdk/EdsdkSource";
import { SettingChanges } from "../edsdk/protocol";
import { createLogger } from "../../util/logger";

const log = createLogger("camera:nikon");

/** Forks the compiled Nikon worker with argv [sdkDir]. Like the Canon worker, only works from dist/. */
export function spawnNikonWorker(sdkDir: string): WorkerHandle {
  const child = fork(path.join(__dirname, "worker.js"), [sdkDir], {
    serialization: "advanced", // photos and frames cross as binary, not JSON
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  // See spawnWorker: an IPC send into a closing channel must not become an uncaught 'error'.
  child.on("error", (err) => log.warn("Nikon worker process error", err));
  return child as unknown as WorkerHandle;
}

/**
 * The Nikon (Z 30) as a CameraSource. The supervision - pings, respawn with
 * backoff, request timeouts - is EdsdkSource's, unchanged: the Nikon worker
 * answers the same protocol - including the operator settings, whose codes
 * are option indexes (nikonSettings.ts). `loadSaved` is the operator's saved
 * settings for this slot, re-applied after every (re)connect.
 */
export function createNikonSource(
  sdkDir: string,
  loadSaved: () => SettingChanges = () => ({}),
  spawn: () => WorkerHandle = () => spawnNikonWorker(sdkDir)
): EdsdkSource {
  return new EdsdkSource(spawn, loadSaved, { brand: "Nikon", filePrefix: "nikon", logName: "camera:nikon" });
}
