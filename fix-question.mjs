/**
 * Driver: render an ADAPT question and run remedy-core's LOCAL fix pipeline
 * (scan → LLM-backed strategies → re-scan) on it. The adapt-a11y-scanner CLI
 * is detect-only; this adds the AI-fix step using the OpenRouter models config
 * from libretexts-remedy/.env. No CXone writes.
 *
 *   node fix-question.mjs <questionId> [assignmentId]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCANNER = path.dirname(fileURLToPath(import.meta.url));
const REMEDY = path.resolve(SCANNER, '..', 'libretexts-remedy'); // sibling repo
const OUT = process.env.REMEDY_DEMO_OUT ?? os.tmpdir();

// Load both .env files into process.env (dotenv-style: strip inline #comments,
// don't clobber already-set vars). Scanner first (ADAPT creds), then remedy
// (OpenRouter key + REMEDY_TEXT_MODELS / REMEDY_VISION_MODELS fallback pools).
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const v = m[2].replace(/\s+#.*$/, '').trim();
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv(path.join(SCANNER, '.env'));
loadEnv(path.join(REMEDY, '.env'));
process.env.DEBUG = '1'; // surface the OpenRouter fallback chain + retries

const [qid = '1', aid] = process.argv.slice(2);

const { loadConfig } = await import(`${SCANNER}/dist/config.js`);
const { AdaptRenderer } = await import(`${SCANNER}/dist/renderer.js`);
const core = await import('@libretexts/remedy-core');

const cfg = loadConfig();
const renderer = new AdaptRenderer(cfg);
await renderer.init();
let html, url;
try {
  ({ url, html } = await renderer.renderQuestion(qid, aid));
} finally {
  await renderer.close();
}
console.error(`[driver] rendered ${url} (${html.length} bytes)`);

const res = await core.runLocalPipeline(html, {
  cacheDir: '', // force LIVE LLM calls (no cache) so we exercise the models
  maxLlmCalls: 20,
  hostname: new URL(cfg.adaptBaseUrl).host, // images resolve off the ADAPT host
});

const tally = (fs_) => {
  const by = {};
  for (const f of fs_) by[f.ruleId] = (by[f.ruleId] || 0) + 1;
  return by;
};
const sev = (fs_, s) => fs_.filter((f) => f.severity === s).length;

console.log('\n===== AI FIX RESULT — question', qid, '=====');
console.log('renderedUrl:', url);
console.log(`BEFORE: ${sev(res.findingsBefore, 'error')} errors / ${sev(res.findingsBefore, 'warning')} warnings`);
console.log(`AFTER:  ${sev(res.findingsAfter, 'error')} errors / ${sev(res.findingsAfter, 'warning')} warnings`);
console.log('elapsedMs:', res.elapsedMs, '| bytePreserved:', res.bytePreserved, '| splices:', res.splicesApplied ?? '-');

console.log('\n-- per-rule before → after --');
const before = tally(res.findingsBefore), after = tally(res.findingsAfter);
for (const k of new Set([...Object.keys(before), ...Object.keys(after)]).values()) {
  const b = before[k] || 0, a = after[k] || 0;
  console.log(`  ${k.padEnd(28)} ${b} → ${a}${a < b ? '  ✓ fixed ' + (b - a) : ''}`);
}

console.log('\n-- strategy reports (which fixers ran) --');
for (const r of res.strategyReports || []) {
  console.log(' ', JSON.stringify(r));
}

fs.writeFileSync(path.join(OUT, `q${qid}.after.html`), res.afterHtml);
fs.writeFileSync(path.join(OUT, `q${qid}.diff`), res.diff);
console.log(`\nwrote ${path.join(OUT, `q${qid}.after.html`)} and q${qid}.diff`);
