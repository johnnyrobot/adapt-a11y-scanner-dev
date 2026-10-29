import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AdaptRenderer } from '../../dist/renderer.js';
import { JobLifetime } from '../../dist/lifecycle.js';
import { buildConfig } from '../../dist/config.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; } };

for (const stage of ['before launch', 'during launch', 'during connect', 'startup cap']) {
  test(`deadline cancels owned browser ${stage}, waits for group exit and prevents downstream work`, { timeout: 15000 }, async t => {
    const folder = await mkdtemp(join(tmpdir(), 'scanner-startup-'));
    t.after(() => rm(folder, { recursive: true, force: true }));
    const preload = join(folder, 'stop.mjs');
    await writeFile(preload, `
      import cp from 'node:child_process';
      if (process.argv[1]?.endsWith('/browser-worker.js')) {
        if (${JSON.stringify(stage)} === 'before launch' || ${JSON.stringify(stage)} === 'startup cap') process.kill(process.pid, 'SIGSTOP');
        else if (${JSON.stringify(stage)} === 'during launch') {
          const spawn = cp.spawn;
          cp.spawn = function (...args) {
            const child = spawn.apply(this, args);
            child.once('spawn', () => process.kill(-process.pid, 'SIGSTOP'));
            return child;
          };
        }
      }
    `);
    const oldOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--import=${preload}`;
    t.after(() => { if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions; });
    let worker, workerDirectory;
    const spawn = childProcess.spawn;
    t.mock.method(childProcess, 'spawn', function (...args) {
      const child = spawn.apply(this, args);
      if (args[1]?.some(arg => String(arg).endsWith('/browser-worker.js'))) { worker = child; workerDirectory = args[2].env.TMPDIR; }
      return child;
    });
    if (stage === 'during connect') {
      const { chromium } = await import('playwright');
      const connect = chromium.connect.bind(chromium);
      t.mock.method(chromium, 'connect', async (...args) => {
        assert.ok(worker?.pid, 'real owned worker exists before connect');
        process.kill(-worker.pid, 'SIGSTOP');
        return connect(...args);
      });
    }
    const calls = [];
    const fixture = createServer((req, res) => { calls.push(req.url); res.end('{}'); });
    fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
    t.after(async () => { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); });
    const base = `http://127.0.0.1:${fixture.address().port}`;
    const cfg = buildConfig({ ADAPT_BASE_URL: base, ADAPT_TOKEN: '', ADAPT_EMAIL: 'fake@example.invalid', ADAPT_PASSWORD: 'fake', SCAN_MODE: 'http', REMEDY_ENDPOINT: `${base}/validate`, REMEDY_API_KEY: 'fake', NAV_TIMEOUT_MS: '10000' });
    const lifetime = new JobLifetime(stage === 'startup cap' ? 20000 : stage === 'during connect' ? 1500 : 700);
    const renderer = new AdaptRenderer(cfg, lifetime);
    t.after(async () => { if (worker?.pid && exists(worker.pid)) process.kill(-worker.pid, 'SIGKILL'); await renderer.close(); lifetime.dispose(); });
    const started = Date.now();
    await assert.rejects(renderer.init(), stage === 'startup cap' ? /Browser startup timed out/ : /deadline/);
    assert.ok(worker?.pid, 'startup was actually attempted in an owned child');
    assert.ok(Date.now() - started < (stage === 'startup cap' ? 12000 : 8500), 'deadline plus cleanup allowance is bounded');
    assert.ok(!exists(worker.pid), 'owned worker has been reaped before init rejects');
    assert.ok(!exists(-worker.pid), 'entire owned process group has exited before init rejects');
    assert.ok(workerDirectory, 'browser temporary files have an owned directory');
    await assert.rejects(access(workerDirectory), { code: 'ENOENT' }, 'forced cleanup removes browser temporary files');
    assert.deepEqual(calls, [], 'cancelled startup performs no login, enumeration, render or validation');
    await pause(100); assert.deepEqual(calls, [], 'no delayed downstream activity');
  });
}

for (const stage of ['during launch', 'during connect']) {
  test(`SIGTERM drains HTTP jobs with a stopped owned browser ${stage}`, { timeout: 18000 }, async t => {
    const folder = await mkdtemp(join(tmpdir(), 'scanner-startup-shutdown-'));
    t.after(() => rm(folder, { recursive: true, force: true }));
    const marker = join(folder, 'stopped-worker.json');
    const preload = join(folder, 'stop.mjs');
    await writeFile(preload, `
      import cp from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import playwright from 'playwright';
      const { chromium } = playwright;
      if (process.argv[1]?.endsWith('/browser-worker.js') && ${JSON.stringify(stage)} === 'during launch') {
        const spawn = cp.spawn;
        cp.spawn = function (...args) {
          const child = spawn.apply(this, args);
          child.once('spawn', () => {
            writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid }));
            process.kill(-process.pid, 'SIGSTOP');
          });
          return child;
        };
      }
      if (process.argv[1]?.endsWith('/dist/server.js') && ${JSON.stringify(stage)} === 'during connect') {
        const spawn = cp.spawn;
        let worker;
        cp.spawn = function (...args) {
          const child = spawn.apply(this, args);
          if (args[1]?.some(arg => String(arg).endsWith('/browser-worker.js'))) worker = child;
          return child;
        };
        const connect = chromium.connect.bind(chromium);
        chromium.connect = (...args) => {
          writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: worker.pid }));
          process.kill(-worker.pid, 'SIGSTOP');
          return connect(...args);
        };
      }
    `);
    // Resolve the preload's Playwright import from the repo, not the temp folder.
    const { pathToFileURL } = await import('node:url');
    const { readFile } = await import('node:fs/promises');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const source = await readFile(preload, 'utf8');
    await writeFile(preload, source.replace("from 'playwright'", `from '${pathToFileURL(require.resolve('playwright')).href}'`));
    const calls = [];
    const fixture = createServer((req, res) => { calls.push(req.url); res.end('{}'); });
    fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
    t.after(async () => { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); });
    const base = `http://127.0.0.1:${fixture.address().port}`;
    const api = childProcess.spawn(process.execPath, ['dist/server.js'], {
      env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, DOTENV_CONFIG_PATH: '/dev/null', ADAPT_BASE_URL: base, ADAPT_TOKEN: 'fake', ADAPT_EMAIL: '', ADAPT_PASSWORD: '', SCAN_MODE: 'http', REMEDY_ENDPOINT: `${base}/validate`, REMEDY_API_KEY: 'fake', SCANNER_API_KEY: 'fake', SCANNER_HOST: '127.0.0.1', SCANNER_PORT: '0', SCANNER_MAX_ACTIVE_JOBS: '1', SCANNER_MAX_QUEUED_JOBS: '1', SCANNER_JOB_TIMEOUT_MS: '20000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errors = '', workerPid;
    api.stdout.on('data', data => output += data); api.stderr.on('data', data => errors += data);
    t.after(async () => {
      if (workerPid && exists(-workerPid)) process.kill(-workerPid, 'SIGKILL');
      if (api.exitCode === null && api.signalCode === null) { const exit = once(api, 'exit'); api.kill('SIGTERM'); await exit; }
    });
    const until = async predicate => { const end = Date.now() + 6000; while (!await predicate()) { assert.ok(Date.now() < end, `fixture timed out: ${errors}`); await pause(10); } };
    await until(() => output.includes('listening') || api.exitCode !== null);
    assert.equal(api.exitCode, null, errors);
    const endpoint = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
    const post = id => fetch(`${endpoint}/v1/adapt/scan`, { method: 'POST', headers: { 'x-api-key': 'fake', 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'question', id }) });
    const active = post(1);
    await until(async () => { try { workerPid = JSON.parse(await readFile(marker, 'utf8')).pid; return true; } catch { return false; } });
    const queued = post(2); await pause(50);
    assert.ok(exists(-workerPid), 'real owned group is alive and stopped before shutdown');
    const exit = once(api, 'exit'); const started = Date.now(); api.kill('SIGTERM');
    for (const response of await Promise.all([active, queued])) {
      assert.equal(response.status, 503); assert.equal((await response.json()).ok, false);
    }
    const [code] = await exit;
    assert.equal(code, 0, errors);
    assert.ok(Date.now() - started < 15000);
    assert.ok(!exists(-workerPid), 'shutdown does not exit until the owned group is gone');
    assert.deepEqual(calls, [], 'shutdown during startup causes no downstream work');
    await pause(100); assert.deepEqual(calls, []);
  });
}

test('unexpected owner exit ends group ownership before delayed final cleanup', { timeout: 10000 }, async t => {
  let worker;
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', function (...args) {
    const child = spawn.apply(this, args);
    if (args[1]?.some(arg => String(arg).endsWith('/browser-worker.js'))) worker = child;
    return child;
  });
  const fixture = createServer((req, res) => {
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><p>Synthetic captured question</p>');
  });
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
  t.after(async () => { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); });
  const base = `http://127.0.0.1:${fixture.address().port}`;
  const renderer = new AdaptRenderer(buildConfig({ ADAPT_BASE_URL: base, ADAPT_TOKEN: 'synthetic', SCAN_MODE: 'http', REMEDY_ENDPOINT: base, REMEDY_API_KEY: 'synthetic' }));
  t.after(() => renderer.close());
  await renderer.init(); await renderer.renderQuestion(1);
  const kill = process.kill.bind(process); const lateSignals = [];
  let permissionRace = false;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === -worker.pid && signal === 0 && !permissionRace) {
      permissionRace = true;
      throw Object.assign(new Error('synthetic exiting-group permission race'), { code: 'EPERM' });
    }
    return kill(pid, signal);
  });
  const exited = once(worker, 'exit'); process.kill(-worker.pid, 'SIGKILL'); await exited;
  for (let i = 0; exists(-worker.pid) && i < 300; i++) await pause(10);
  assert.ok(!exists(-worker.pid), 'original owned group has disappeared');
  assert.ok(permissionRace, 'exercise the OS permission race without treating it as disappearance');
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === -worker.pid && signal !== 0) lateSignals.push(signal);
    return kill(pid, signal);
  });
  // Represents later job cleanup after a slow validation response. The old
  // identifier may have been recycled by then; it must never be signalled.
  await pause(100); await renderer.close();
  assert.deepEqual(lateSignals, []);
});
