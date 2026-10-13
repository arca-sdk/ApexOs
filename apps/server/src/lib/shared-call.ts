/**
 * Caches the outcome of a slow TrueNAS call and shares one request between everyone asking.
 *
 * Some calls need the internet (the app catalog, the update check). On a server without it they take
 * from 15 seconds to minutes to fail, so failures are remembered too, and pages that only use the result
 * as a nice-to-have don't wait for it (`quick`).
 */
export class SharedCall<T> {
  private last: { at: number; result: PromiseSettledResult<T> } | null = null;
  private pending: Promise<T> | null = null;
  private generation = 0;

  constructor(private readonly ttl: { okMs: number; failedMs: number }) {}

  /** The remembered outcome while it is fresh, otherwise one shared run of `load`. */
  get(load: () => Promise<T>): Promise<T> {
    const last = this.last;
    if (last) {
      const age = Date.now() - last.at;
      if (last.result.status === 'fulfilled' && age < this.ttl.okMs) return Promise.resolve(last.result.value);
      if (last.result.status === 'rejected' && age < this.ttl.failedMs) return Promise.reject(last.result.reason);
    }
    if (!this.pending) {
      const generation = this.generation;
      const settle = (result: PromiseSettledResult<T>) => {
        if (generation !== this.generation) return;
        this.last = { at: Date.now(), result };
        this.pending = null;
      };
      this.pending = load().then(
        (value) => {
          settle({ status: 'fulfilled', value });
          return value;
        },
        (reason: unknown) => {
          settle({ status: 'rejected', reason });
          throw reason;
        },
      );
    }
    return this.pending;
  }

  /**
   * Like `get`, but answers `fallback` when the outcome isn't ready within `waitMs` or is a failure. The
   * call carries on in the background, so a later request gets its result.
   */
  async quick<F>(load: () => Promise<T>, waitMs: number, fallback: F): Promise<T | F> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<F>((resolve) => {
      timer = setTimeout(() => resolve(fallback), waitMs);
      timer.unref();
    });
    try {
      return await Promise.race([this.get(load).catch(() => fallback), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Forgets the outcome (and ignores a call still in flight), e.g. after a change that affects it. */
  invalidate(): void {
    this.generation += 1;
    this.last = null;
    this.pending = null;
  }
}
