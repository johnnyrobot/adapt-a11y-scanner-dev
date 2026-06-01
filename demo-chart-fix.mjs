/**
 * End-to-end demo: render an image-bearing ADAPT question and run remedy-core's
 * vision fix pipeline on it. Renders Q via the scanner (real ADAPT auth + DOM),
 * rewrites the chart asset URL to a local mirror (works around Node's inability
 * to resolve *.localhost — see docs/INTEGRATION.md), then runs runLocalPipeline
 * so the chart-longdesc vision handler generates an accessible description.
 *
 *   node demo-chart-fix.mjs <questionId>
 *
 * Prereqs: SCAN_MODE=in-process with @libretexts/remedy-core linked, and a local
 * static mirror of the chart asset:
 *   python3 -m http.server 8899 --bind 127.0.0.1   # serving the dir with the PNG
 * Override the mirror with REMEDY_MIRROR_URL, output dir with REMEDY_DEMO_OUT.
 */
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCANNER = path.dirname(fileURLToPath(import.meta.url));
const MIRROR = process.env.REMEDY_MIRROR_URL ?? 'http://127.0.0.1:8899';
const OUT = process.env.REMEDY_DEMO_OUT ?? path.join(os.tmpdir(), 'remedy-demo');
fs.mkdirSync(OUT, { recursive: true });

// dotenv loaded this CWD's .env. Also pull in the scanner's .env (ADAPT creds)
// if we're running from elsewhere.
const scannerEnv = path.join(SCANNER, '.env');
if (fs.existsSync(scannerEnv)) {
  for (const line of fs.readFileSync(scannerEnv, 'utf8').split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').trim();
  }
}
process.env.DEBUG = '1';

const qid = process.argv[2] ?? '2';
const { loadConfig } = await import(path.join(SCANNER, 'dist/config.js'));
const { AdaptRenderer } = await import(path.join(SCANNER, 'dist/renderer.js'));
const core = await import('@libretexts/remedy-core');

const cfg = loadConfig();
const renderer = new AdaptRenderer(cfg);
await renderer.init();
let html, url;
try {
  ({ url, html } = await renderer.renderQuestion(qid));
} finally {
  await renderer.close();
}

// Rewrite the ADAPT-hosted chart asset to the Node-fetchable local mirror.
// Keeps "chart" in the filename so the classifier signal is preserved.
const before = html;
html = html
  .replaceAll('http://adapt.libretexts.localhost/assets/img/', `${MIRROR}/`)
  .replaceAll('/assets/img/', `${MIRROR}/`);
console.error(`[demo] rendered ${url} (${before.length} bytes); rewrote chart asset → ${MIRROR}`);

const mirrorHost = new URL(MIRROR).host;
const res = await core.runLocalPipeline(html, { cacheDir: '', maxLlmCalls: 20, hostname: mirrorHost });

const imgReport = (res.strategyReports || []).find((r) => r.strategyId === 'images');
console.log('\n===== END-TO-END VISION FIX — question', qid, '=====');
console.log('renderedUrl:', url);
console.log('images strategy:', JSON.stringify(imgReport));

const after = res.afterHtml;
const altMatch = after.match(/<img[^>]*\balt="([^"]*)"[^>]*>/i);
const detailsMatch = after.match(/<details>[\s\S]*?<p>([\s\S]*?)<\/p>[\s\S]*?<\/details>/i);
const tableRows = [...after.matchAll(/<t[dh][^>]*>([^<]*)<\/t[dh]>/gi)].map((m) => m[1].trim());
console.log('\n-- BEFORE alt:', JSON.stringify((before.match(/<img[^>]*\balt="([^"]*)"/i) || [])[1]));
console.log('-- AFTER  alt:', JSON.stringify(altMatch ? altMatch[1] : '(none)'));
console.log('-- long description:', detailsMatch ? JSON.stringify(detailsMatch[1].trim()) : '(none)');
if (tableRows.length) console.log('-- data table cells:', JSON.stringify(tableRows.slice(0, 16)));

fs.writeFileSync(path.join(OUT, 'q.before.html'), before);
fs.writeFileSync(path.join(OUT, 'q.after.html'), after);
fs.writeFileSync(path.join(OUT, 'q.result.json'), JSON.stringify({
  renderedUrl: url,
  beforeAlt: (before.match(/<img[^>]*\balt="([^"]*)"/i) || [])[1],
  afterAlt: altMatch ? altMatch[1] : null,
  longDescription: detailsMatch ? detailsMatch[1].trim() : null,
  dataTableCells: tableRows,
  imagesReport: imgReport,
}, null, 2));
console.log(`\nwrote ${OUT}/q.{before,after}.html + q.result.json`);
