/** Private browser owner. No ADAPT content, authentication or HTTP work runs here.
 * Playwright 1.60's launchServer timeout does not reach ProgressController.run.
 * This process is therefore owned before launch, rather than awaiting a handle.
 */
import childProcess, { type SpawnOptions } from 'node:child_process';
import { chromium, type BrowserServer } from 'playwright';

if (!process.send || !['darwin', 'linux'].includes(process.platform)) {
  throw new Error('Browser worker requires private IPC on macOS or Linux');
}

// Pinned Playwright 1.60 launchProcess detaches Chromium into another process
// group. Keep every launch in THIS already-owned group instead, including a
// launch that stalls before returning BrowserServer. This override is confined
// to the private worker; the scanner process and its other children are intact.
// Playwright's negative-browser-PID kill fallback cannot kill this group. The
// parent provides the authoritative group kill and waits for actual group exit.
const spawn = childProcess.spawn;
childProcess.spawn = ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, options?: SpawnOptions) => {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
  const opts = Array.isArray(argsOrOptions) ? options : argsOrOptions as SpawnOptions | undefined;
  return spawn(command, args, { ...opts, detached: false });
}) as typeof childProcess.spawn;

let server: BrowserServer | undefined;
let stopping = false;
let finishing: Promise<void> | undefined;
function finish(): Promise<void> {
  stopping = true;
  if (!server) return Promise.resolve(); // pending launch remains owned until parent escalation
  return finishing ??= (async () => {
    try { await server!.close(); }
    finally { process.disconnect?.(); }
  })();
}
const stop = () => { void finish().catch(() => { process.exitCode = 1; }); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGHUP', stop);
process.on('disconnect', stop);
process.on('message', message => {
  if (message === 'close') stop();
});

process.once('message', async message => {
  if (!message || typeof message !== 'object' || !('sandbox' in message) || typeof message.sandbox !== 'boolean') return;
  try {
    server = await chromium.launchServer({
      host: '127.0.0.1', handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false,
      chromiumSandbox: message.sandbox, args: message.sandbox ? [] : ['--no-sandbox'],
    });
    if (stopping) { await finish(); return; }
    process.send?.({ endpoint: server.wsEndpoint() });
  } catch {
    // Do not forward browser logs: launch diagnostics may contain environment
    // or filesystem information. Sandbox failure never triggers a retry.
    process.send?.({ error: 'Chromium launch failed (check sandbox prerequisites)' });
    process.disconnect?.();
    process.exitCode = 1;
  }
});
