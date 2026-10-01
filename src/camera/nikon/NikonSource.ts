import { fork } from "node:child_process";
import path from "node:path";
import { EdsdkSource, WorkerHandle } from "../edsdk/EdsdkSource";
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
 * answers the same protocol. It has no operator settings yet, so nothing is
 * re-applied on connect.
 */
export function createNikonSource(sdkDir: string, spawn: () => WorkerHandle = () => spawnNikonWorker(sdkDir)): EdsdkSource {
  return new EdsdkSource(spawn, () => ({}), { brand: "Nikon", filePrefix: "nikon", logName: "camera:nikon" });
}
