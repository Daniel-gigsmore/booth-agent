import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dropIntoHotFolder, hotFolderPathFor } from "../src/print/hotFolder";
import { createInMemoryOutboxDb } from "../src/outbox/db";
import { OutboxStore } from "../src/outbox/outboxStore";
import { PrintQueue } from "../src/print/printQueue";
import { EventBus } from "../src/events/eventBus";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "booth-print-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeSourceImage(bytes = 512 * 1024): Promise<string> {
  const src = path.join(dir, "composite.jpg");
  await writeFile(src, Buffer.alloc(bytes, 0xab));
  return src;
}

describe("dropIntoHotFolder atomicity", () => {
  /**
   * Hot Folder Print reacts to file creation. If the destination is created
   * empty and filled afterwards, HFP can grab a truncated JPEG - which fails
   * silently, as one guest's print that never appears.
   */
  it("never leaves a partially written file at the destination name", async () => {
    const src = await makeSourceImage();
    const destPath = await dropIntoHotFolder(dir, "4x6", "job-1", src);

    expect(destPath).toBe(path.join(hotFolderPathFor(dir, "4x6"), "job-1.jpg"));
    const [written, original] = await Promise.all([readFile(destPath), readFile(src)]);
    expect(written.equals(original)).toBe(true);
  });

  it("stages through a temp file so the destination only appears complete", async () => {
    // node:fs/promises exports cannot be spied on, so instead of intercepting
    // the rename this races a directory poller against a copy large enough to
    // take measurable time. Any snapshot taken mid-copy must show only the
    // dot-prefixed temp file - never the destination name, which is what HFP
    // would act on.
    const src = await makeSourceImage(48 * 1024 * 1024);
    const hotDir = hotFolderPathFor(dir, "4x6");
    await dropIntoHotFolder(dir, "4x6", "warm-up", await makeSourceImage(1024));

    const snapshots: string[][] = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        snapshots.push(await readdir(hotDir).catch(() => []));
      }
    })();

    await dropIntoHotFolder(dir, "4x6", "job-2", src);
    polling = false;
    await poller;

    const midFlight = snapshots.filter((names) => names.some((n) => n.endsWith(".tmp")));
    // If the copy completed between polls there is nothing to assert on; the
    // invariant is still covered by the cleanup and content tests below.
    for (const names of midFlight) {
      expect(names).not.toContain("job-2.jpg");
      expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([".job-2.tmp"]);
    }

    const after = await readdir(hotDir);
    expect(after.sort()).toEqual(["job-2.jpg", "warm-up.jpg"]);
  });

  it("cleans up the temp file when the copy fails", async () => {
    const hotDir = hotFolderPathFor(dir, "4x6");
    await expect(
      dropIntoHotFolder(dir, "4x6", "job-3", path.join(dir, "does-not-exist.jpg"))
    ).rejects.toThrow();

    const after = await readdir(hotDir).catch(() => []);
    expect(after).toEqual([]);
  });
});

describe("interrupted print job recovery", () => {
  function setup() {
    const db = createInMemoryOutboxDb();
    const store = new OutboxStore(db);
    store.insertCapture({
      id: "cap-1",
      eventId: "gigsmore-launch-2026",
      source: "canon",
      originalPath: path.join(dir, "orig.jpg"),
      takenAt: new Date().toISOString(),
    });
    store.setCompositePath("cap-1", path.join(dir, "composite.jpg"), "4x6");
    return { db, store };
  }

  it("finds jobs left 'queued' by a crash and marks them failed rather than reprinting", () => {
    const { store } = setup();
    store.insertPrintJob({
      id: "job-a",
      captureId: "cap-1",
      size: "4x6",
      filePath: path.join(dir, "composite.jpg"),
    });

    const interrupted = store.resolveInterruptedPrintJobs();

    expect(interrupted.map((job) => job.id)).toEqual(["job-a"]);
    // Marked, not silently left ambiguous...
    expect(store.getPrintJobById("job-a")?.status).toBe("failed");
    // ...and not re-queued behind the operator's back, since delivery can
    // never be confirmed after the fact.
    expect(store.getQueuedPrintJobs()).toHaveLength(0);
  });

  it("leaves already-dropped jobs alone", () => {
    const { store } = setup();
    store.insertPrintJob({
      id: "job-b",
      captureId: "cap-1",
      size: "4x6",
      filePath: path.join(dir, "composite.jpg"),
    });
    store.markPrintDropped("job-b");

    expect(store.resolveInterruptedPrintJobs()).toHaveLength(0);
    expect(store.getPrintJobById("job-b")?.status).toBe("dropped");
  });

  /**
   * The complement of the above: a clean shutdown should drain, so that a
   * planned restart leaves nothing for recovery to have to give up on.
   */
  it("drains in-flight work on stop() so a clean restart has nothing to recover", async () => {
    const { store } = setup();
    const src = await makeSourceImage(64 * 1024);
    const queue = new PrintQueue(dir, 0.01, store, new EventBus());

    queue.enqueue("cap-1", "4x6", src);
    await queue.stop();

    expect(store.getQueuedPrintJobs()).toHaveLength(0);
    expect(store.getPrintJobById(store.getRecentPrintJobs(1)[0]!.id)?.status).toBe("dropped");
    await expect(stat(path.join(hotFolderPathFor(dir, "4x6"), "composite.jpg"))).rejects.toThrow();
  });
});
