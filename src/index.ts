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
import { AdaptRenderer } from './renderer.js';
import { scanHtml } from './scanner.js';
import { listAssignmentQuestions } from './adapt-client.js';
import { summarize } from './report.js';
import type { QuestionScanResult } from './types.js';

function usage(): never {
  console.error('usage: adapt-a11y-scanner <question <id> [assignmentId] | assignment <id>>');
  process.exit(2);
}

async function scanOne(
  renderer: AdaptRenderer,
  cfg: ReturnType<typeof loadConfig>,
  questionId: number | string,
  assignmentId?: number | string,
): Promise<QuestionScanResult> {
  const base = {
    questionId,
    assignmentId,
    renderedUrl: '',
    capturedBytes: 0,
    scannedAt: new Date().toISOString(),
    findings: [],
    overallPassed: false,
    failed: false,
    stats: { errors: 0, warnings: 0, total: 0 },
  } satisfies QuestionScanResult;
  try {
    const { url, html } = await renderer.renderQuestion(questionId, assignmentId);
    const { findings, overallPassed } = await scanHtml(html, cfg);
    const errors = findings.filter((f) => f.severity === 'error').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    return {
      ...base,
      renderedUrl: url,
      capturedBytes: Buffer.byteLength(html, 'utf8'),
      findings,
      overallPassed,
      stats: { errors, warnings, total: findings.length },
    };
  } catch (e) {
    return { ...base, error: (e as Error).message, failed: true };
  }
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

  const renderer = new AdaptRenderer(cfg);
  await renderer.init();

  const results: QuestionScanResult[] = [];
  try {
    if (cmd === 'question') {
      results.push(await scanOne(renderer, cfg, a, b));
    } else {
      const questions = await listAssignmentQuestions(cfg.adaptBaseUrl, renderer.getToken(), a);
      console.error(`[bridge] scanning ${questions.length} question(s) in assignment ${a}`);
      for (const q of questions) results.push(await scanOne(renderer, cfg, q.id, a));
    }
  } finally {
    await renderer.close();
  }

  const { totals, exitCode } = summarize(results);
  console.log(JSON.stringify({ scanMode: cfg.scanMode, renderMode: cfg.renderMode, totals, results }, null, 2));
  // M3: set exitCode and let the event loop drain stdout, rather than
  // process.exit() which truncates a large piped JSON report.
  process.exitCode = exitCode;
}

main().catch((e) => {
  console.error('[bridge] fatal:', (e as Error).message);
  process.exit(3);
});
