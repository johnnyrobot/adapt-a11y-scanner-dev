// Explicit browser integration suite; helper-only npm test needs no browser.
// Run with DOTENV_CONFIG_PATH=/dev/null so no local credentials are loaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, readlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { AdaptRenderer } from '../../dist/renderer.js';
import { buildConfig } from '../../dist/config.js';

const evidence = { node: process.version, platform: process.platform, cases: [] };
const isLinux = process.platform === 'linux';

// Sandboxed renderers may deny same-UID /proc namespace inspection. Elevation
// reads only these known process links; the scanner/browser never runs as root.
async function namespace(pid, kind) {
  assert.match(String(pid), /^[1-9][0-9]*$/);
  assert.ok(['user', 'pid'].includes(kind));
  const path = `/proc/${pid}/ns/${kind}`;
  try { return await readlink(path); }
  catch (error) {
    if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
    return execFileSync('sudo', ['-n', 'readlink', path], { encoding: 'utf8', timeout: 5000 }).trim();
  }
}

async function processEvidence(pid) {
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  const field = name => {
    const value = status.split('\n').find(line => line.startsWith(`${name}:`))?.slice(name.length + 1).trim();
    assert.ok(value, `missing ${name} for PID ${pid}`);
    return value.trim();
  };
  return {
    pid, uid: field('Uid'), seccomp: field('Seccomp'), noNewPrivs: field('NoNewPrivs'),
    namespacePids: field('NSpid'), userNamespace: await namespace(pid, 'user'),
    pidNamespace: await namespace(pid, 'pid'),
  };
}

test('real renderer enables the sandbox by default', { timeout: 90000 }, async t => {
  if (process.env.SANDBOX_LINUX_REQUIRED === '1') {
    assert.ok(isLinux, 'required Linux verification must run on Linux');
  }
  if (isLinux) {
    assert.notEqual(process.getuid(), 0, 'run the scanner/browser as non-root');
    evidence.os = await readFile('/etc/os-release', 'utf8');
    evidence.parent = await processEvidence(process.pid);
  }
  const server = createServer((req, res) => {
    if (req.url !== '/api/get-header-html/1') {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html lang="en"><title>Sandbox fixture</title><body><p id="question">Synthetic no-math question</p></body></html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const launch = chromium.launch.bind(chromium);
  try {
    // Each variant launches the actual renderer. Observation delegates to real
    // Chromium and adds no production hook or access to renderer private state.
    for (const value of [undefined, '0', 'false', '1', 'true']) {
      await t.test(`CHROMIUM_NO_SANDBOX=${value ?? '(unset)'}`, async t => {
        const disabled = value === '1' || value === 'true';
        let browser;
        let options;
        t.mock.method(chromium, 'launch', async opts => {
          options = opts;
          browser = await launch(opts);
          return browser;
        });
        const cfg = buildConfig({
          ADAPT_BASE_URL: base, ADAPT_TOKEN: 'synthetic-token', SCAN_MODE: 'http',
          REMEDY_ENDPOINT: `${base}/unused-validator`, REMEDY_API_KEY: 'synthetic-key',
          CHROMIUM_NO_SANDBOX: value,
        });
        const renderer = new AdaptRenderer(cfg);
        try {
          await renderer.init();
          const session = await browser.newBrowserCDPSession();
          const initial = await session.send('SystemInfo.getProcessInfo');
          const browserPid = initial.processInfo.find(p => p.type === 'browser')?.id;
          assert.ok(browserPid, 'browser PID must be observable');
          const args = isLinux
            ? (await readFile(`/proc/${browserPid}/cmdline`, 'utf8')).split('\0').filter(Boolean)
            : execFileSync('ps', ['-ww', '-p', String(browserPid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 }).trim().split(/\s+/);
          const record = { value: value ?? '(unset)', options, args, chromium: browser.version() };
          evidence.cases.push(record);
          // Assert actual process arguments first: this catches Playwright's
          // implicit --no-sandbox even when application options look harmless.
          assert.equal(args.includes('--no-sandbox'), disabled);
          assert.equal(options.chromiumSandbox, !disabled);
          if (!disabled) {
            for (const flag of ['--disable-namespace-sandbox', '--disable-seccomp-filter-sandbox', '--single-process']) {
              assert.ok(!args.includes(flag), `unexpected ${flag}`);
            }
          }
          // Keep a real document alive for process inspection in this same
          // browser; renderQuestion closes its own page after capturing it.
          const witness = await browser.contexts()[0].newPage();
          await witness.goto(`${base}/api/get-header-html/1`);
          if (isLinux && !disabled) {
            const { processInfo } = await session.send('SystemInfo.getProcessInfo');
            const browserProcess = processInfo.find(p => p.type === 'browser');
            assert.ok(browserProcess, 'browser PID must be observable');
            record.browser = await processEvidence(browserProcess.id);
            assert.ok(record.browser.uid.split(/\s+/).every(uid => uid !== '0'));
            const renderers = processInfo.filter(p => p.type === 'renderer');
            assert.ok(renderers.length > 0, 'a live renderer is required for sandbox proof');
            record.renderers = [];
            for (const process of renderers) {
              const child = await processEvidence(process.id);
              record.renderers.push(child);
              assert.equal(child.seccomp, '2');
              assert.equal(child.noNewPrivs, '1');
              for (const parent of [record.browser, evidence.parent]) {
                assert.notEqual(child.userNamespace, parent.userNamespace);
                assert.notEqual(child.pidNamespace, parent.pidNamespace);
              }
              assert.ok(child.namespacePids.split(/\s+/).length > 1);
            }
            assert.equal(evidence.parent.seccomp, '0', 'native CI proof must not rely on inherited container seccomp');
          }
          const captured = await renderer.renderQuestion(1);
          assert.match(captured.html, /<p id="question">Synthetic no-math question<\/p>/);
          record.capturedBytes = Buffer.byteLength(captured.html);
        } finally {
          await renderer.close();
          if (browser) assert.equal(browser.isConnected(), false, 'renderer must release the browser');
          t.mock.restoreAll();
        }
      });
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (process.env.SANDBOX_EVIDENCE_PATH) {
      await writeFile(process.env.SANDBOX_EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
    }
  }
});

test('sandbox launch failure propagates without an unsandboxed retry', async t => {
  const failure = new Error('synthetic sandbox launch failure');
  const launch = t.mock.method(chromium, 'launch', async () => { throw failure; });
  const cfg = buildConfig({
    ADAPT_BASE_URL: 'http://127.0.0.1', ADAPT_TOKEN: 'synthetic-token',
    SCAN_MODE: 'http', REMEDY_ENDPOINT: 'http://127.0.0.1/unused', REMEDY_API_KEY: 'synthetic-key',
  });
  const renderer = new AdaptRenderer(cfg);
  try {
    await assert.rejects(renderer.init(), error => error === failure);
    assert.equal(launch.mock.callCount(), 1);
  } finally { await renderer.close(); }
});
