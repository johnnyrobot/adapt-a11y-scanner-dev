/**
 * Tests for the remedy-server response contract (MF-1): the scanner must parse
 * the server's real response shape ({ all_violations: [...], overall_passed })
 * and map each violation's `impact` to the canonical error/warning severity the
 * CI exit gate keys on. Run against the compiled dist via `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize,
  mapImpact,
  parseRemedyResponse,
  buildRemedyHeaders,
  parseRetryAfterMs,
  backoffMs,
  parseJsonStrict,
} from '../dist/scanner.js';

test('parseRetryAfterMs parses delta-seconds and ignores junk (MF-6)', () => {
  assert.equal(parseRetryAfterMs('2'), 2000);
  assert.equal(parseRetryAfterMs('0'), 0);
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs('soon'), undefined);
});

test('backoffMs honors Retry-After then falls back to capped exponential (MF-6)', () => {
  assert.equal(backoffMs(0), 1000);
  assert.equal(backoffMs(1), 2000);
  assert.equal(backoffMs(2), 4000);
  assert.equal(backoffMs(10), 30000); // capped
  assert.equal(backoffMs(0, 5000), 5000); // server-provided wins
});

test('parseJsonStrict throws a descriptive error on a non-JSON body (L1)', () => {
  assert.deepEqual(parseJsonStrict('{"a":1}', 'remedy-server'), { a: 1 });
  assert.throws(() => parseJsonStrict('<html>502</html>', 'remedy-server'), /remedy-server returned non-JSON/);
});

test('buildRemedyHeaders sends X-API-Key and never Authorization (MF-3)', () => {
  const h = buildRemedyHeaders({ remedyApiKey: 'secret' });
  assert.equal(h['X-API-Key'], 'secret');
  assert.equal(h.Authorization, undefined);
});

test('buildRemedyHeaders omits the key header when none configured', () => {
  assert.deepEqual(buildRemedyHeaders({ remedyApiKey: undefined }), {});
});

test('mapImpact: critical and serious map to error', () => {
  assert.equal(mapImpact('critical'), 'error');
  assert.equal(mapImpact('serious'), 'error');
});

test('mapImpact: moderate and minor map to warning', () => {
  assert.equal(mapImpact('moderate'), 'warning');
  assert.equal(mapImpact('minor'), 'warning');
  assert.equal(mapImpact(undefined), 'warning');
});

test('normalize maps a server axe violation to a Finding', () => {
  const items = [
    {
      id: 'image-alt',
      impact: 'critical',
      tool: 'axe',
      description: 'Images must have alternate text',
      wcag: 'wcag2a,wcag111',
      html_snippets: ['<img src="x">', '<img src="y">'],
    },
  ];
  const [f] = normalize(items);
  assert.equal(f.ruleId, 'image-alt');
  assert.equal(f.severity, 'error');
  assert.equal(f.message, 'Images must have alternate text');
  assert.equal(f.source, 'axe');
  assert.equal(f.wcag, 'wcag2a,wcag111');
  assert.equal(f.snippet, '<img src="x">');
});

test('normalize maps a pa11y violation using context/selector', () => {
  const items = [
    {
      id: 'WCAG2AA.Principle1.Guideline1_1.1_1_1.H37',
      impact: 'serious',
      tool: 'pa11y',
      description: 'Img element missing an alt attribute.',
      context: '<p>x</p>',
      selector: '#main > p',
    },
  ];
  const [f] = normalize(items);
  assert.equal(f.severity, 'error');
  assert.equal(f.snippet, '<p>x</p>');
  assert.equal(f.selector, '#main > p');
  assert.equal(f.source, 'pa11y');
});

test('normalize leaves wcag/selector/snippet undefined for lighthouse-shaped items', () => {
  const items = [{ id: 'color-contrast', impact: 'moderate', tool: 'lighthouse', description: 'Low contrast' }];
  const [f] = normalize(items);
  assert.equal(f.severity, 'warning');
  assert.equal(f.wcag, undefined);
  assert.equal(f.selector, undefined);
  assert.equal(f.snippet, undefined);
});

test('parseRemedyResponse reads all_violations and overall_passed', () => {
  const body = {
    axe: { score: 1, passed: false, violations: [] },
    overall_passed: false,
    all_violations: [
      { id: 'image-alt', impact: 'critical', tool: 'axe', description: 'x' },
      { id: 'link-name', impact: 'serious', tool: 'axe', description: 'y' },
    ],
  };
  const { findings, overallPassed } = parseRemedyResponse(body);
  assert.equal(findings.length, 2);
  assert.equal(findings.filter((f) => f.severity === 'error').length, 2);
  assert.equal(overallPassed, false);
});

test('parseRemedyResponse: a passing report yields no error findings and overallPassed true', () => {
  const { findings, overallPassed } = parseRemedyResponse({ overall_passed: true, all_violations: [] });
  assert.equal(findings.length, 0);
  assert.equal(overallPassed, true);
});

test('parseRemedyResponse treats a missing/legacy shape as fail-closed (no silent pass)', () => {
  // Old code returned [] + exit 0 for an unrecognized shape. The verdict must
  // not silently read "passed" when the server gave us nothing recognizable.
  const { findings, overallPassed } = parseRemedyResponse({ findings: [{ ruleId: 'x' }] });
  assert.equal(findings.length, 0); // we no longer read the legacy `findings` key
  assert.equal(overallPassed, false); // missing overall_passed => not passed
});
