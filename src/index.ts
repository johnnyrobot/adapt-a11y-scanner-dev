#!/usr/bin/env node
/**
 * adapt-a11y-scanner — CLI / job entry point.
 *
 *   adapt-a11y-scanner question <questionId> [assignmentId]
 *   adapt-a11y-scanner assignment <assignmentId>
 *
 * Renders each ADAPT question headlessly, scans the rendered DOM with Remedy,
 * and prints a JSON report to stdout. The exit code fails CLOSED (see report.ts):
 * non-zero if any question is not-passed, has error findings, or failed to
 * render/scan — so CI / a job can gate on it. Codes: 0 ok, 1 problems found,
 * 2 usage, 3 fatal.
 */
import { loadConfig } from './config.js';
import { JobLifetime, ShutdownError } from './lifecycle.js';
import { runAdaptScan } from './job.js';

function usage(): never {
  console.error('usage: adapt-a11y-scanner <question <id> [assignmentId] | assignment <id>>');
  process.exit(2);
}

async function main(): Promise<void> {
  // Validate the command + required args BEFORE loading config or launching a
  // browser (L14): a bad invocation must exit 2 cheaply, not after a full launch.
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd !== 'question' && cmd !== 'assignment') usage();
  if (!a) usage();

  const cfg = loadConfig();
  if (cmd === 'question' && cfg.renderMode === 'spa' && b == null) {
    console.error('[bridge] RENDER_MODE=spa needs an assignmentId: question <questionId> <assignmentId>');
    process.exit(2);
  }

  const lifetime = new JobLifetime(cfg.jobTimeoutMs);
  const interrupt = () => lifetime.abort(new ShutdownError());
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);
  try {
    const report = await runAdaptScan({
      mode: cmd,
      id: a,
      assignmentId: b,
    }, lifetime);
    console.log(JSON.stringify(report, null, 2));
    // M3: set exitCode and let the event loop drain stdout, rather than
    // process.exit() which truncates a large piped JSON report.
    process.exitCode = report.exitCode;
  } finally {
    lifetime.dispose();
    process.removeListener('SIGTERM', interrupt);
    process.removeListener('SIGINT', interrupt);
  }
}

main().catch((e) => {
  console.error('[bridge] fatal:', (e as Error).message);
  process.exit(3);
});
