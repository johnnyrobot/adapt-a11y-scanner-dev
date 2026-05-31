#!/usr/bin/env node
/**
 * adapt-a11y-scanner — CLI / job entry point.
 *
 *   adapt-a11y-scanner question <questionId> [assignmentId]
 *   adapt-a11y-scanner assignment <assignmentId>
 *
 * Renders each ADAPT question headlessly, scans the rendered DOM with Remedy,
 * and prints a JSON report to stdout. Exit code is non-zero if any question has
 * accessibility ERRORS (so CI / a job can gate on it).
 */
import { loadConfig } from './config.js';
import { AdaptRenderer } from './renderer.js';
import { scanHtml } from './scanner.js';
import { listAssignmentQuestions } from './adapt-client.js';
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
    stats: { errors: 0, warnings: 0, total: 0 },
  } satisfies QuestionScanResult;
  try {
    const { url, html } = await renderer.renderQuestion(questionId, assignmentId);
    const findings = await scanHtml(html, cfg);
    const errors = findings.filter((f) => f.severity === 'error').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    return { ...base, renderedUrl: url, capturedBytes: html.length, findings, stats: { errors, warnings, total: findings.length } };
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}

async function main(): Promise<void> {
  const [cmd, a, b] = process.argv.slice(2);
  if (!cmd) usage();
  const cfg = loadConfig();
  const renderer = new AdaptRenderer(cfg);
  await renderer.init();

  const results: QuestionScanResult[] = [];
  try {
    if (cmd === 'question') {
      if (!a) usage();
      results.push(await scanOne(renderer, cfg, a, b));
    } else if (cmd === 'assignment') {
      if (!a) usage();
      const questions = await listAssignmentQuestions(cfg.adaptBaseUrl, renderer.getToken(), a);
      console.error(`[bridge] scanning ${questions.length} question(s) in assignment ${a}`);
      for (const q of questions) results.push(await scanOne(renderer, cfg, q.id, a));
    } else {
      usage();
    }
  } finally {
    await renderer.close();
  }

  const totals = results.reduce(
    (acc, r) => ({ errors: acc.errors + r.stats.errors, warnings: acc.warnings + r.stats.warnings }),
    { errors: 0, warnings: 0 },
  );
  console.log(JSON.stringify({ scanMode: cfg.scanMode, renderMode: cfg.renderMode, totals, results }, null, 2));
  process.exit(totals.errors > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[bridge] fatal:', (e as Error).message);
  process.exit(3);
});
