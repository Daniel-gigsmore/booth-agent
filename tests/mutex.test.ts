import { describe, expect, it } from "vitest";
import { AsyncMutex } from "../src/util/mutex";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AsyncMutex", () => {
  /**
   * This is what fixes WebcamSource: capture() and getLiveviewFrame() both
   * open the same exclusive dshow device, and without serialization a
   * live-view poll racing a shutter press produces a "device busy" failure
   * on whichever call loses. A slower first job must still finish before a
   * faster second job - queued behind it - is allowed to start.
   */
  it("runs jobs one at a time, in submission order, even when a later job is faster", async () => {
    const mutex = new AsyncMutex();
    const log: string[] = [];

    const first = mutex.run(async () => {
      log.push("first-start");
      await delay(30);
      log.push("first-end");
    });
    const second = mutex.run(async () => {
      log.push("second-start");
      await delay(1);
      log.push("second-end");
    });

    await Promise.all([first, second]);

    expect(log).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  it("resolves each job with its own return value", async () => {
    const mutex = new AsyncMutex();

    const a = mutex.run(async () => 1);
    const b = mutex.run(async () => "two");

    await expect(a).resolves.toBe(1);
    await expect(b).resolves.toBe("two");
  });

  it("a rejected job doesn't jam the queue for jobs behind it", async () => {
    const mutex = new AsyncMutex();
    const log: string[] = [];

    const failing = mutex.run(async () => {
      throw new Error("device busy");
    });
    const next = mutex.run(async () => {
      log.push("next-ran");
      return "ok";
    });

    await expect(failing).rejects.toThrow("device busy");
    await expect(next).resolves.toBe("ok");
    expect(log).toEqual(["next-ran"]);
  });
});
