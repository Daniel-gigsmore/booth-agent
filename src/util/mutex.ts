/**
 * Serializes async work through a single FIFO queue - callers run one at a
 * time, in submission order, instead of racing each other for a resource
 * that only tolerates one user at a time (e.g. a DirectShow device, which a
 * second exclusive open fails against while the first is still in progress).
 * A job throwing doesn't jam the queue for whoever's queued behind it - each
 * caller's own promise still resolves/rejects with that job's own outcome.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
