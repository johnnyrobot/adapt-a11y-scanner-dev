import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRemedyResponse } from '../dist/scanner.js';

const manifest = JSON.parse(readFileSync(new URL('./fixtures/contracts/v1/remedy-html-validation.json', import.meta.url)));
const example = name => structuredClone(manifest.examples.find(e => e.name === name).body);

test('malformed collection cannot masquerade as a clean pass', () => {
  const body = example('pass');
  body.all_violations = 'invalid';
  assert.throws(() => parseRemedyResponse(body), /contract/i);
});

test('required Server envelope types and findings fail closed', () => {
  const mutations = [
    b => { b.overall_passed = 'true'; },
    b => { delete b.summary; },
    b => { delete b.pa11y; },
    b => { b.axe.passed = 1; },
    b => { b.lighthouse.score = Infinity; },
    b => { delete b.wave.score; },
    b => { b.pa11y.violations = {}; },
    b => { b.all_violations = [null]; },
    b => { b.axe.violations = [{ tool: 'axe', id: 'x', description: '', impact: 'error' }]; },
  ];
  for (const mutate of mutations) {
    const body = example('pass'); mutate(body);
    assert.throws(() => parseRemedyResponse(body), /contract/i);
  }
});

test('contradictory clean verdicts fail closed', () => {
  const missingMerged = example('warning'); missingMerged.all_violations = [];
  const hiddenSevere = example('accessibility_failure'); hiddenSevere.overall_passed = true;
  const failedChecker = example('partial_checker_failure'); failedChecker.overall_passed = true;
  for (const body of [missingMerged, hiddenSevere, failedChecker]) {
    assert.throws(() => parseRemedyResponse(body), /contract/i);
  }
});

test('source-serialized Server cases retain verdict and severity, with additive fields', () => {
  const expected = { pass: [true, []], warning: [true, ['warning']], accessibility_failure: [false, ['error']], partial_checker_failure: [false, []], null_impact: [true, ['warning']] };
  for (const entry of manifest.examples) {
    const body = structuredClone(entry.body); body.future_metadata = { additive: true };
    const result = parseRemedyResponse(body);
    assert.deepEqual([result.overallPassed, result.findings.map(f => f.severity)], expected[entry.name]);
  }
});

test('actual optional finding types accept empty strings and Lighthouse shapes', () => {
  const body = example('pass');
  const finding = { tool: '', id: '', description: '', impact: 'moderate', score: 0.5 };
  body.lighthouse = { passed: false, score: 90, violations: [finding] };
  body.all_violations = [finding];
  const result = parseRemedyResponse(body);
  assert.equal(result.overallPassed, true);
  assert.equal(result.findings[0].ruleId, '');
  for (const [key, invalid] of Object.entries({ wcag: [], selector: null, context: 3, help: {}, help_url: false, html_snippets: [1], nodes_count: -1, score: '0.5', impact: 'Error', id: 1, tool: null, description: false })) {
    const bad = structuredClone(body); bad.all_violations[0][key] = invalid;
    assert.throws(() => parseRemedyResponse(bad), /contract/);
  }
});
