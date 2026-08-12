import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrintQueue } from "../src/print/printQueue";
import { createInMemoryOutboxDb } from "../src/outbox/db";
import { OutboxStore } from "../src/outbox/outboxStore";
import { EventBus } from "../src/events/eventBus";

let hotFolderBase: string;
let sourceFilePath: string;

beforeAll(async () => {
  hotFolderBase = await mkdtemp(path.join(tmpdir(), "booth-agent-printq-"));
  sourceFilePath = path.join(hotFolderBase, "composite.jpg");
  await writeFile(sourceFilePath, "fake composite bytes");
});

afterAll(async () => {
  await rm(hotFolderBase, { recursive: true, force: true });
});

function makeQueue(secondsPerPrint: number) {
  const db = createInMemoryOutboxDb();
  const store = new OutboxStore(db);
  store.insertCapture({
    id: "capture-1",
    eventId: "event-1",
    source: "webcam",
    originalPath: sourceFilePath,
    takenAt: new Date().toISOString(),
  });
  const eventBus = new EventBus();
  return new PrintQueue(hotFolderBase, secondsPerPrint, store, eventBus);
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe("PrintQueue", () => {
  it("assigns increasing queue positions and wait estimates across rapid back-to-back prints", () => {
    const queue = makeQueue(10); // 10s/print, long enough that nothing drains mid-test
    const jobs = [1, 2, 3, 4, 5].map(() => queue.enqueue("capture-1", "4x6", sourceFilePath));

    expect(jobs.map((j) => j.queuePosition)).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < jobs.length; i++) {
      expect(jobs[i]!.estimatedWaitMs).toBeGreaterThan(jobs[i - 1]!.estimatedWaitMs);
    }
  });

  it("gives every job its own file in the hot folder, even when they share one composite", async () => {
    const queue = makeQueue(0.01); // fast, so the test doesn't have to wait long
    const jobs = [1, 2, 3, 4, 5].map(() => queue.enqueue("capture-1", "4x6", sourceFilePath));

    const dir = path.join(hotFolderBase, "s4x6"); // HFP's real folder name for 4x6, see hotFolder.ts
    await waitFor(async () => {
      const files = await readdir(dir).catch(() => []);
      return files.length >= 5;
    });

    const files = await readdir(dir);
    const jobFiles = jobs.map((j) => `${j.jobId}.jpg`);
    for (const expected of jobFiles) {
      expect(files).toContain(expected);
    }
    expect(new Set(files).size).toBe(files.length); // no filename collisions
  });

  it("drains a job out of the pending queue once its simulated print duration elapses", async () => {
    const queue = makeQueue(0.02);
    queue.enqueue("capture-1", "4x6", sourceFilePath);
    expect(queue.getQueue().length).toBe(1);

    await waitFor(() => queue.getQueue().length === 0, 1000);
  });
});
