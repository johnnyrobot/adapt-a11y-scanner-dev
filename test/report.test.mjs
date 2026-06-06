/**
 * Tests for the fail-closed CI gate (MF-2, defeating H1/H2/M4 together).
 * `summarize` decides the process exit code from the per-question results:
 * it must exit non-zero when ANY question is not-passed, errored, or failed to
 * render/scan — and only exit 0 when every attempted question genuinely passed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../dist/report.js';

const ok = (id) => ({
  questionId: id, renderedUrl: 'u', capturedBytes: 1, scannedAt: 't',
  findings: [], overallPassed: true, failed: false,
  stats: { errors: 0, warnings: 0, total: 0 },
});
const withError = (id) => ({
  ...ok(id), overallPassed: false,
  findings: [{ ruleId: 'image-alt', severity: 'error', message: '' }],
  stats: { errors: 1, warnings: 0, total: 1 },
});
const failedQ = (id) => ({ ...ok(id), overallPassed: false, failed: true, error: 'boom' });

test('all questions pass => exit 0', () => {
  const s = summarize([ok(1), ok(2)]);
  assert.equal(s.exitCode, 0);
  assert.equal(s.totals.scanned, 2);
  assert.equal(s.totals.failed, 0);
  assert.equal(s.totals.notPassed, 0);
});

test('a question with error findings => exit 1 (H1 severity now gated, M4 not silently passed)', () => {
  const s = summarize([ok(1), withError(2)]);
  assert.equal(s.exitCode, 1);
  assert.equal(s.totals.errors, 1);
  assert.equal(s.totals.notPassed, 1);
});

test('a swallowed per-question render/scan failure => exit 1 (H2 fail-closed)', () => {
  const s = summarize([ok(1), failedQ(2)]);
  assert.equal(s.exitCode, 1);
  assert.equal(s.totals.failed, 1);
});

test('every question failed => exit 1 and scanned 0', () => {
  const s = summarize([failedQ(1), failedQ(2)]);
  assert.equal(s.exitCode, 1);
  assert.equal(s.totals.scanned, 0);
});

test('overall_passed=false with only warnings still fails closed', () => {
  const r = {
    ...ok(1), overallPassed: false,
    findings: [{ ruleId: 'x', severity: 'warning', message: '' }],
    stats: { errors: 0, warnings: 1, total: 1 },
  };
  const s = summarize([r]);
  assert.equal(s.exitCode, 1);
  assert.equal(s.totals.notPassed, 1);
});
