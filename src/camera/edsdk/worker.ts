/**
 * Entry point of the camera worker child process (forked by EdsdkSource with
 * the EDSDK.dll path as argv[2]). Owns the only EDSDK session on the machine;
 * every EDSDK call happens on this process's single thread.
 */
import { CameraWorker } from "./CameraWorker";
import { loadEdsdk } from "./edsdkNative";
import { RequestBody, WorkerMessage, WorkerRequest } from "./protocol";
import { AsyncMutex } from "../../util/mutex";

const TICK_MS = 30;

const dllPath = process.argv[2];
if (!dllPath || !process.send) {
  console.error("camera worker: must be forked by EdsdkSource with the EDSDK.dll path");
  process.exit(2);
}

const send = (message: WorkerMessage): void => {
  process.send?.(message);
};

const worker = new CameraWorker(loadEdsdk(dllPath), send);
worker.start();

const loop = setInterval(() => {
  try {
    worker.tick();
  } catch (err) {
    send({ type: "log", level: "error", message: `tick failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}, TICK_MS);

const captureLock = new AsyncMutex();

function stop(): never {
  clearInterval(loop);
  worker.shutdown();
  process.exit(0);
}

async function handle(request: RequestBody): Promise<Uint8Array | null> {
  switch (request.type) {
    case "capture":
      await captureLock.run(() => worker.capture(request.destPath));
      return null;
    case "frame":
      return worker.frame();
    case "ping":
      return null;
    case "shutdown":
      setImmediate(stop); // answer first, then exit
      return null;
  }
}

process.on("message", (request: WorkerRequest) => {
  handle(request).then(
    (result) => send({ id: request.id, ok: true, result }),
    (err: unknown) => send({ id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  );
});

// The agent went away without saying goodbye: release the camera anyway.
process.on("disconnect", stop);
