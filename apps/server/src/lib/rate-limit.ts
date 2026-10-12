/**
 * Failed sign-in attempts per client address, with exponential backoff: the first few mistakes are
 * free, then each further failure doubles a waiting period (1 s, 2 s, 4 s … up to 15 minutes).
 * Failures are forgotten an hour after the last one, or on a successful sign-in.
 */
export interface AttemptLimiterOptions {
  freeAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  forgetAfterMs: number;
  /** Upper bound on remembered addresses (oldest are dropped first). */
  maxEntries: number;
}

interface Entry {
  failures: number;
  lockedUntil: number;
  lastFailure: number;
}

export class AttemptLimiter {
  /** Clock; tests replace it. */
  now: () => number = Date.now;
  private readonly entries = new Map<string, Entry>();
  private readonly opts: AttemptLimiterOptions;

  constructor(opts: Partial<AttemptLimiterOptions> = {}) {
    this.opts = { freeAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 15 * 60_000, forgetAfterMs: 60 * 60_000, maxEntries: 10_000, ...opts };
  }

  private entry(key: string): Entry | undefined {
    const e = this.entries.get(key);
    if (e && this.now() - e.lastFailure > this.opts.forgetAfterMs && this.now() >= e.lockedUntil) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  /** Milliseconds `key` must wait before its next attempt (0 = may try now). */
  retryAfterMs(key: string): number {
    const e = this.entry(key);
    return e ? Math.max(0, e.lockedUntil - this.now()) : 0;
  }

  /** Records a failure; returns the wait now imposed (0 while still within the free attempts). */
  fail(key: string): number {
    const now = this.now();
    const e = this.entry(key) ?? { failures: 0, lockedUntil: 0, lastFailure: now };
    e.failures += 1;
    e.lastFailure = now;
    const over = e.failures - this.opts.freeAttempts;
    const delay = over > 0 ? Math.min(this.opts.baseDelayMs * 2 ** Math.min(over - 1, 30), this.opts.maxDelayMs) : 0;
    e.lockedUntil = now + delay;
    // Re-insert so iteration order is "least recently failed first".
    this.entries.delete(key);
    this.entries.set(key, e);
    while (this.entries.size > this.opts.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    return delay;
  }

  succeed(key: string): void {
    this.entries.delete(key);
  }
}
