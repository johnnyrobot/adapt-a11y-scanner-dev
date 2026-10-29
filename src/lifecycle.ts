/** One absolute deadline, created at admission and retained while queued. */
export class JobLifetime {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onAbort: () => void;

  constructor(timeoutMs: number, private readonly parent?: AbortSignal) {
    this.deadline = performance.now() + timeoutMs;
    this.timer = setTimeout(() => this.abort(new Error('Scan job deadline exceeded')), timeoutMs);
    this.onAbort = () => this.abort(parent!.reason);
    parent?.addEventListener('abort', this.onAbort, { once: true });
    if (parent?.aborted) this.onAbort();
  }

  abort(reason: unknown = new Error('Scan job cancelled')): void {
    this.controller.abort(reason);
  }

  timeout(cap: number): number {
    this.check();
    const remaining = Math.ceil(this.deadline - performance.now());
    if (remaining <= 0) {
      this.abort(new Error('Scan job deadline exceeded'));
      this.check();
    }
    return Math.max(1, Math.min(cap, remaining, 2_147_483_647));
  }

  check(): void {
    if (performance.now() >= this.deadline) this.abort(new Error('Scan job deadline exceeded'));
    this.signal.throwIfAborted();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.parent?.removeEventListener('abort', this.onAbort);
  }
}

export async function abortableSleep(ms: number, lifetime?: JobLifetime): Promise<void> {
  lifetime?.check();
  await new Promise<void>((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const abort = () => { clearTimeout(timer); cleanup(); reject(lifetime!.signal.reason); };
    const cleanup = () => lifetime?.signal.removeEventListener('abort', abort);
    const timer = setTimeout(done, lifetime ? lifetime.timeout(ms) : ms);
    lifetime?.signal.addEventListener('abort', abort, { once: true });
  });
  lifetime?.check();
}

/** Covers fetch AND body consumption; listeners/timers end with the attempt.
 * Avoid AbortSignal.any so the documented Node 20 minimum remains supported. */
export async function withRequestSignal<T>(
  timeoutMs: number | undefined,
  parent: AbortSignal | undefined,
  run: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (timeoutMs === undefined && !parent) return run(undefined);
  const controller = new AbortController();
  const abort = () => controller.abort(parent!.reason);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  const timer = timeoutMs === undefined ? undefined : setTimeout(
    () => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  try { controller.signal.throwIfAborted(); return await run(controller.signal); }
  finally { clearTimeout(timer); parent?.removeEventListener('abort', abort); }
}
