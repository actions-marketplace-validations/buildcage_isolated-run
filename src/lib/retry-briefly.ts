export interface RetryBrieflyOptions {
  attempts?: number;
  delayMs?: number;
  /** Which failures are worth another try. Every one of them, by default. */
  retryOn?: (e: unknown) => boolean;
}

/**
 * Run `fn`, retrying a failure a few times with a pause in between: a teardown
 * the kernel is still holding (an overlay mount's own bookkeeping, a lazy
 * unmount) clears on its own within a short, bounded window.
 *
 * Named for how long it waits rather than for what it waits on. Only a caller
 * whose failure carries an errno can single EBUSY out through `retryOn`; one
 * that shells out to `rm` is handed an exit status instead, and has to wait the
 * window out on any failure.
 *
 * The pause is synchronous, since every caller is on a synchronous cleanup
 * path where there is nothing else to do meanwhile.
 */
export function retryBriefly<T>(fn: () => T, options: RetryBrieflyOptions = {}): T {
  const { attempts = 5, delayMs = 200, retryOn = () => true } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt >= attempts || !retryOn(e)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}
