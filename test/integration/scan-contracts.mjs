import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { runAdaptScan } from '../../dist/job.js';

const manifest = JSON.parse(readFileSync(new URL('../fixtures/contracts/v1/remedy-html-validation.json', import.meta.url)));
const example = name => structuredClone(manifest.examples.find(e => e.name === name).body);

async function cli(env) {
  const child = spawn(process.execPath, ['dist/index.js', 'assignment', '42'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

test('source-backed contracts through real renderer, job, CLI and HTTP API', { timeout: 60000 }, async t => {
  let validations = 0;
  let assignment = { type: 'success', question_ids_array: [] };
  let validation = example('pass');
  let validatorStatus = 200;
  let invalidJSON = false;
  const fixture = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/assignments/42/questions/ids') {
      res.end(JSON.stringify(assignment));
    } else if (req.url === '/api/get-header-html/7') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html lang="en"><title>Contract fixture</title><body><p>Synthetic no-math question</p></body></html>');
    } else if (req.url === '/validate') {
      for await (const chunk of req) { /* drain synthetic upload */ }
      validations++;
      res.statusCode = validatorStatus;
      res.end(invalidJSON ? '<html>synthetic error</html>' : JSON.stringify(validation));
    } else { res.writeHead(404).end(); }
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const base = `http://127.0.0.1:${fixture.address().port}`;
  const env = { ADAPT_BASE_URL: base, ADAPT_TOKEN: 'synthetic-token', SCAN_MODE: 'http', RENDER_MODE: 'iframe', REMEDY_ENDPOINT: `${base}/validate`, REMEDY_API_KEY: 'synthetic-key', CHROMIUM_NO_SANDBOX: '0', NAV_TIMEOUT_MS: '3000', MATHJAX_TIMEOUT_MS: '1000', REMEDY_TIMEOUT_MS: '1000' };
  const original = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  let api;
  try {
    await t.test('recognized empty assignment is no-work through the real job', async () => {
    const report = await runAdaptScan({ mode: 'assignment', id: 42 });
    assert.equal(report.exitCode, 1);
    assert.equal(report.outcome, 'no_work');
    assert.match(report.message, /no questions/i);
    assert.deepEqual(report.results, []);
    assert.deepEqual(report.totals, { errors: 0, warnings: 0, scanned: 0, failed: 0, notPassed: 0 });
    assert.equal(validations, 0);
    });
    const childEnv = { ...process.env, ...env, DOTENV_CONFIG_PATH: '/dev/null' };
    await t.test('CLI preserves no-work report and process exit code', async () => {
      const result = await cli(childEnv);
      assert.equal(result.code, 1, result.stderr);
      assert.equal(JSON.parse(result.stdout).outcome, 'no_work');
      assert.equal(validations, 0);
    });

    // Reserve a free loopback port without starting a public listener.
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    api = spawn(process.execPath, ['dist/server.js'], { env: { ...childEnv, SCANNER_HOST: '127.0.0.1', SCANNER_PORT: String(port), SCANNER_API_KEY: 'synthetic-scanner-key', SCANNER_ALLOW_UNAUTHENTICATED: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let apiErrors = '';
    api.stderr.on('data', data => { apiErrors = (apiErrors + data).slice(-5000); });
    await Promise.race([
      once(api.stdout, 'data').then(([data]) => assert.match(String(data), /listening/)),
      once(api, 'exit').then(() => { throw new Error(`API exited: ${apiErrors}`); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('API startup timeout')), 5000).unref()),
    ]);
    const post = async (id = 42) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/adapt/scan`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'synthetic-scanner-key' }, body: JSON.stringify({ mode: 'assignment', id }), signal: AbortSignal.timeout(15000) });
      return { status: response.status, body: await response.json() };
    };
    await t.test('HTTP empty work is ok=false, never a fabricated question failure', async () => {
      const { status, body } = await post();
      assert.equal(status, 200); assert.equal(body.ok, false);
      assert.equal(body.outcome, 'no_work'); assert.equal(body.exitCode, 1);
      assert.deepEqual(body.results, []); assert.equal(body.totals.failed, 0);
      assert.equal(validations, 0);
    });
    await t.test('unknown assignment and HTTP200 application errors are contract failures', async () => {
      for (const body of [{}, { type: 'error', question_ids_array: [] }]) {
        assignment = body;
        const result = await post();
        assert.equal(result.status, 500); assert.equal(result.body.ok, false);
        assert.match(result.body.error, /contract/); assert.equal(result.body.outcome, undefined);
      }
      const result = await cli(childEnv);
      assert.equal(result.code, 3); assert.match(result.stderr, /contract/);
      assert.equal(validations, 0);
    });
    await t.test('invalid assignment IDs are client errors without validation calls', async () => {
      const result = await post(-1);
      assert.equal(result.status, 400); assert.equal(result.body.ok, false);
      assert.equal(validations, 0);
    });
    assignment = { type: 'success', question_ids_array: [7] };
    for (const [name, exitCode, warnings, notPassed] of [['pass', 0, 0, 0], ['warning', 0, 1, 0], ['accessibility_failure', 1, 0, 1], ['partial_checker_failure', 1, 0, 1], ['null_impact', 0, 1, 0]]) {
      await t.test(`HTTP serialized ${name} retains its verdict through the real job`, async () => {
        validation = example(name);
        const { status, body } = await post();
        assert.equal(status, 200); assert.equal(body.exitCode, exitCode);
        assert.equal(body.ok, exitCode === 0); assert.equal(body.outcome, undefined);
        assert.equal(body.totals.scanned, 1); assert.equal(body.totals.failed, 0);
        assert.equal(body.totals.warnings, warnings); assert.equal(body.totals.notPassed, notPassed);
        assert.equal(body.results[0].questionId, 7); assert.ok(body.results[0].capturedBytes > 0);
      });
    }
    await t.test('malformed, non-JSON and non-2xx validator responses cannot pass', async () => {
      const malformed = example('pass'); malformed.all_violations = 'invalid';
      for (const [status, body, nonJSON] of [[200, malformed, false], [200, {}, true], [503, { detail: 'synthetic dependency failure' }, false], [401, { detail: 'Unauthorized' }, false]]) {
        validatorStatus = status; validation = body; invalidJSON = nonJSON;
        const result = await post();
        assert.equal(result.body.ok, false); assert.equal(result.body.exitCode, 1);
        assert.equal(result.body.totals.failed, 1); assert.equal(result.body.totals.scanned, 0);
      }
    });
  } finally {
    if (api && api.exitCode === null && api.signalCode === null) {
      const stopped = once(api, 'exit'); api.kill('SIGTERM'); await stopped;
    }
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fixture.closeAllConnections();
    await new Promise((resolve, reject) => fixture.close(e => e ? reject(e) : resolve()));
  }
});
