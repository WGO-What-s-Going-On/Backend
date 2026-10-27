export type NearbyFailure =
  | 'DEADLINE_EXCEEDED'
  | 'RESOURCE_EXHAUSTED'
  | 'CANCELLED';
export class NearbySearchError extends Error {
  constructor(readonly code: NearbyFailure) {
    super(code);
  }
}
export type NearbyContext = { deadline?: number; signal?: AbortSignal };
export type NearbyLimits = {
  timeoutMs: number;
  maxQueries: number;
  maxCandidates: number;
  readTimeoutMs: number;
};
export function nearbyLimits(): NearbyLimits {
  const value = (name: string, fallback: number, max: number) => {
    const n = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(n) || n < 1 || n > max)
      throw new Error(`Invalid ${name}`);
    return n;
  };
  return {
    timeoutMs: value('MAP_NEARBY_TIMEOUT_MS', 500, 10000),
    maxQueries: value('MAP_NEARBY_MAX_QUERIES', 4500, 100000),
    maxCandidates: value('MAP_NEARBY_MAX_CANDIDATES', 2000, 100000),
    readTimeoutMs: value('MAP_NEARBY_READ_TIMEOUT_MS', 250, 10000),
  };
}
export class NearbyBudget {
  readonly controller = new AbortController();
  private readonly startedAt = performance.now();
  private readonly endsAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly candidates = new Set<string>();
  private queries = 0;
  private readonly onCancel = () => this.fail('CANCELLED');
  constructor(
    readonly limits: NearbyLimits,
    private readonly context: NearbyContext = {},
  ) {
    const duration = Math.min(
      limits.timeoutMs,
      (context.deadline ?? Infinity) - Date.now(),
    );
    this.endsAt = performance.now() + Math.max(0, duration);
    this.timer = setTimeout(
      () => this.fail('DEADLINE_EXCEEDED'),
      Math.max(0, duration),
    );
    this.timer.unref();
    context.signal?.addEventListener('abort', this.onCancel, { once: true });
    if (context.signal?.aborted) this.onCancel();
  }
  fail(code: NearbyFailure): void {
    if (!this.controller.signal.aborted)
      this.controller.abort(new NearbySearchError(code));
  }
  check(): void {
    if (performance.now() >= this.endsAt) this.fail('DEADLINE_EXCEEDED');
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
  }
  remaining(): number {
    this.check();
    return Math.max(1, Math.ceil(this.endsAt - performance.now()));
  }
  chargeQuery(count = 1): void {
    this.check();
    if (this.queries + count > this.limits.maxQueries)
      this.fail('RESOURCE_EXHAUSTED');
    this.check();
    this.queries += count;
  }
  addCandidates(ids: Iterable<string>): void {
    this.check();
    for (const id of ids) {
      if (
        !this.candidates.has(id) &&
        this.candidates.size >= this.limits.maxCandidates
      )
        this.fail('RESOURCE_EXHAUSTED');
      this.check();
      this.candidates.add(id);
    }
  }
  async wait<T>(promise: Promise<T>): Promise<T> {
    void promise.catch(() => {});
    this.check();
    const signal = this.controller.signal;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      promise
        .then((value) => {
          try {
            this.check();
            resolve(value);
          } catch (error) {
            reject(error);
          }
        }, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    });
  }
  snapshot() {
    return {
      logicalQueries: this.queries,
      candidates: this.candidates.size,
      elapsedMs: Math.round(performance.now() - this.startedAt),
    };
  }
  close(): void {
    clearTimeout(this.timer);
    this.context.signal?.removeEventListener('abort', this.onCancel);
  }
}
