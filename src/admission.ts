import { JobLifetime, ShutdownError } from './lifecycle.js';

export class UnavailableError extends Error {
  constructor() { super('Scanner saturated or shutting down'); }
}

interface Entry {
  lifetime: JobLifetime;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  waitingAbort: () => void;
}

/** Capacity follows actual run completion, including cleanup after cancellation. */
export class ScanAdmission {
  private active = 0;
  private readonly queue: Entry[] = [];
  private readonly jobs = new Set<Entry>();
  accepting = true;

  constructor(private readonly limit: number, private readonly queueLimit: number) {}

  submit<T>(lifetime: JobLifetime, run: () => Promise<T>): Promise<T> {
    if (!this.accepting || (this.active >= this.limit && this.queue.length >= this.queueLimit)) {
      lifetime.dispose();
      return Promise.reject(new UnavailableError());
    }
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = { lifetime, run, resolve: value => resolve(value as T), reject,
        waitingAbort: () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) { this.queue.splice(index, 1); this.jobs.delete(entry); lifetime.dispose(); reject(lifetime.signal.reason); }
        },
      };
      this.jobs.add(entry);
      if (this.active < this.limit) this.start(entry);
      else {
        this.queue.push(entry);
        lifetime.signal.addEventListener('abort', entry.waitingAbort, { once: true });
        if (lifetime.signal.aborted) entry.waitingAbort();
      }
    });
  }

  stop(): void {
    this.accepting = false;
    for (const entry of this.jobs) entry.lifetime.abort(new ShutdownError());
  }

  get idle(): boolean { return this.jobs.size === 0; }

  private start(entry: Entry): void {
    this.active++;
    entry.lifetime.signal.removeEventListener('abort', entry.waitingAbort);
    void (async () => {
      try { entry.lifetime.check(); entry.resolve(await entry.run()); }
      catch (error) { entry.reject(error); }
      finally {
        entry.lifetime.dispose();
        this.jobs.delete(entry);
        this.active--;
        const next = this.queue.shift();
        if (next) this.start(next);
      }
    })();
  }
}
