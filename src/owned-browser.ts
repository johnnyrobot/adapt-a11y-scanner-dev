import childProcess, { type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Owns startup AND lifetime. Only the group created by our detached spawn is
 * signalled. Never infer a browser PID from ps, logs, endpoints or a PID file. */
export class OwnedBrowser {
  private readonly child: ChildProcess;
  private readonly directory: string;
  private readonly exited: Promise<void>;
  private readonly endpoint: Promise<string>;
  private rejectEndpoint!: (error: Error) => void;
  private closing?: Promise<void>;
  private readonly startupTimer: ReturnType<typeof setTimeout>;
  private startupFailure?: Error;

  constructor(sandbox: boolean, startupMs: number) {
    if (!['darwin', 'linux'].includes(process.platform)) {
      throw new Error('Browser process ownership currently requires macOS or Linux');
    }
    if (process.platform === 'linux' && process.pid === 1) {
      throw new Error('Browser cleanup requires a reaping init on Linux (run the container with --init)');
    }
    this.directory = mkdtempSync(join(tmpdir(), 'adapt-browser-'));
    this.child = childProcess.spawn(process.execPath, [fileURLToPath(new URL('./browser-worker.js', import.meta.url))], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, TMPDIR: this.directory },
    });
    this.exited = new Promise(resolve => {
      this.child.once('exit', () => resolve());
      this.child.once('error', () => { if (!this.child.pid) resolve(); });
    });
    this.endpoint = new Promise((resolve, reject) => {
      this.rejectEndpoint = reject;
      this.child.on('message', message => {
        if (!message || typeof message !== 'object') return;
        if ('endpoint' in message && typeof message.endpoint === 'string') resolve(message.endpoint);
        else if ('error' in message) reject(new Error('Chromium launch failed (check sandbox prerequisites)'));
      });
      this.child.once('error', () => reject(new Error('Unable to start browser worker')));
      this.child.once('exit', () => reject(new Error('Browser worker exited during startup')));
    });
    // The renderer awaits this immediately, but keep a rejection handler even
    // if the caller closes before starting its await.
    void this.endpoint.catch(() => {});
    this.startupTimer = setTimeout(() => {
      this.startupFailure = new Error('Browser startup timed out');
      void this.close().catch(() => {}); // init/final cleanup awaits the same result
    }, startupMs);
    this.child.once('spawn', () => {
      if (!this.closing) this.child.send({ sandbox }, () => {});
    });
  }

  wsEndpoint(): Promise<string> { return this.endpoint; }

  /** The single startup allowance includes both launch and connect. */
  started(): void {
    if (this.startupFailure) throw this.startupFailure;
    if (this.closing) throw new Error('Browser startup cancelled');
    clearTimeout(this.startupTimer);
  }

  close(): Promise<void> {
    return this.closing ??= this.closeGroup();
  }

  private signalGroup(signal: NodeJS.Signals | 0): boolean {
    const pid = this.child.pid;
    if (!pid) return false; // spawn failed: no owned group was created
    try { process.kill(-pid, signal); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  }

  private async closeGroup(): Promise<void> {
    clearTimeout(this.startupTimer);
    this.rejectEndpoint(this.startupFailure ?? new Error('Browser startup cancelled'));
    if (this.child.connected) this.child.send('close', () => {});
    // Signal also handles worker startup before its IPC listener was installed.
    // An early SIGTERM exits Node; group verification below still cleans children.
    this.signalGroup('SIGTERM');
    const timer = setTimeout(() => { this.signalGroup('SIGKILL'); }, 5000);
    try {
      await this.exited;
      // Unexpected worker death can leave children behind. Kill this exact
      // owned group immediately, then wait for it to disappear before release.
      if (this.signalGroup(0)) this.signalGroup('SIGKILL');
      while (this.signalGroup(0)) await new Promise(resolve => setTimeout(resolve, 10));
      // Forced worker death bypasses Playwright's finally blocks. Its private
      // temporary root is owned here and removed only after all users exit.
      await rm(this.directory, { recursive: true, force: true });
    } finally { clearTimeout(timer); }
  }
}
