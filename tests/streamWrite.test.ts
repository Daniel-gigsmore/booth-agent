import { describe, expect, it, afterEach } from "vitest";
import { createServer, Server } from "node:http";
import { connect, Socket } from "node:net";
import type { Response } from "express";
import { writeBackpressureAware } from "../src/server/streamWrite";

let server: Server | undefined;
let client: Socket | undefined;

afterEach(async () => {
  client?.destroy();
  client = undefined;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

/**
 * Mirrors what /liveview actually does: write large chunks in a loop,
 * routing every write through writeBackpressureAware(), until the response
 * is destroyed. A 1MB chunk over a paused/unread socket reliably produces
 * real kernel-level backpressure (res.write() returning false), which is
 * the only way to exercise the "close" race honestly - mocking res.write()
 * would just test the mock.
 */
function startBackpressureServer(): Promise<{
  port: number;
  settled: Promise<{ outcome: "destroyed" | "finished"; ms: number }>;
}> {
  return new Promise((resolveStart) => {
    let resolveSettled: (v: { outcome: "destroyed" | "finished"; ms: number }) => void;
    const settled = new Promise<{ outcome: "destroyed" | "finished"; ms: number }>((resolve) => {
      resolveSettled = resolve;
    });

    server = createServer(async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      const chunk = Buffer.alloc(1024 * 1024, 0x41);
      const start = Date.now();
      try {
        for (let i = 0; i < 500; i++) {
          await writeBackpressureAware(res as unknown as Response, chunk);
          if (res.destroyed) {
            resolveSettled({ outcome: "destroyed", ms: Date.now() - start });
            return;
          }
        }
        resolveSettled({ outcome: "finished", ms: Date.now() - start });
      } finally {
        if (!res.writableEnded) res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      resolveStart({ port: (server!.address() as { port: number }).port, settled });
    });
  });
}

describe("writeBackpressureAware", () => {
  /**
   * The regression this guards: a response emits "close" on client
   * disconnect, never "drain" - confirmed live before this fix. Waiting on
   * "drain" alone hangs the writer forever in exactly this situation,
   * leaking the request handler's closure for the life of the process.
   * With the fix, the writer must unblock (via the "close" race) well
   * within a few hundred ms of the disconnect, not hang until a test
   * timeout kills it.
   */
  it("unblocks promptly when the client disconnects mid-backpressure, instead of hanging on 'drain'", async () => {
    const { port, settled } = await startBackpressureServer();

    client = connect(port, "127.0.0.1", () => {
      client!.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
      let received = 0;
      client!.on("data", (data) => {
        received += data.length;
        if (received > 1024 * 1024 * 2) {
          // Stop reading (forces the kernel send buffer to fill, so the
          // server's next write() genuinely returns false) then disconnect.
          client!.pause();
          setTimeout(() => client!.destroy(), 50);
        }
      });
    });

    const result = await Promise.race([
      settled,
      new Promise<{ outcome: string; ms: number }>((_, reject) =>
        setTimeout(() => reject(new Error("writer did not unblock within 3s - it hung on 'drain'")), 3000)
      ),
    ]);

    expect(result.outcome).toBe("destroyed");
    expect(result.ms).toBeLessThan(2000);
  });
});
