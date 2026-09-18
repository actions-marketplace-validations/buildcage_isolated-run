export interface RetryOnBusyOptions {
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
 * The pause is synchronous, since every caller is on a synchronous cleanup
 * path where there is nothing else to do meanwhile.
 */
export function retryOnBusy<T>(fn: () => T, options: RetryOnBusyOptions = {}): T {
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
