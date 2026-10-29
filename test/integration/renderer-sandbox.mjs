// Explicit browser integration suite; helper-only npm test needs no browser.
// Run with DOTENV_CONFIG_PATH=/dev/null so no local credentials are loaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, readlink, writeFile, rename, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess, { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { AdaptRenderer } from '../../dist/renderer.js';
import { buildConfig } from '../../dist/config.js';

const evidence = { node: process.version, platform: process.platform, cases: [] };
const isLinux = process.platform === 'linux';
const inShippingContainer = process.env.SANDBOX_CONTAINER_REQUIRED === '1';

// A sandbox renderer can deny even same-UID namespace reads. The CI host
// observer reads only processes returned by docker top for this test container;
// no inspection capability or root user is added to the production container.
async function containerNamespaces(pid) {
  const directory = process.env.SANDBOX_AUDIT_DIR;
  assert.ok(directory, 'shipping-container proof requires a host namespace observer');
  const requestId = `${process.pid}-${pid}-${Date.now()}`;
  await writeFile(`${directory}/${requestId}.request.tmp`, JSON.stringify({ pid, requestId }));
  await rename(`${directory}/${requestId}.request.tmp`, `${directory}/${requestId}.request.json`);
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const audit = JSON.parse(await readFile(`${directory}/${requestId}.response.json`, 'utf8'));
      assert.equal(audit.containerPid, pid);
      assert.equal(audit.requestId, requestId);
      assert.ok(audit.hostPid > 0);
      assert.match(audit.userNamespace, /^user:\[\d+\]$/);
      assert.match(audit.pidNamespace, /^pid:\[\d+\]$/);
      return audit;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      assert.ok(Date.now() < deadline, `host namespace observer did not inspect PID ${pid}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}

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
  const namespaces = inShippingContainer ? await containerNamespaces(pid) : {
    userNamespace: await namespace(pid, 'user'), pidNamespace: await namespace(pid, 'pid'),
  };
  return {
    pid, uid: field('Uid'), seccomp: field('Seccomp'), noNewPrivs: field('NoNewPrivs'),
    seccompFilters: Number(field('Seccomp_filters')), capabilities: field('CapEff'),
    namespacePids: field('NSpid'), ...namespaces,
  };
}

test('real renderer enables the sandbox by default', { timeout: 90000 }, async t => {
  if (process.env.SANDBOX_LINUX_REQUIRED === '1' || inShippingContainer) {
    assert.ok(isLinux, 'required Linux verification must run on Linux');
  }
  if (isLinux) {
    assert.notEqual(process.getuid(), 0, 'run the scanner/browser as non-root');
    evidence.os = await readFile('/etc/os-release', 'utf8');
    evidence.parent = await processEvidence(process.pid);
    if (inShippingContainer) {
      assert.equal(process.arch, 'x64', 'only Linux amd64 shipping proof is supported');
      assert.equal(evidence.parent.seccomp, '2');
      assert.equal(evidence.parent.noNewPrivs, '1');
      assert.equal(BigInt(`0x${evidence.parent.capabilities}`), 0n);
      assert.match(await readFile('/proc/1/cmdline', 'utf8'), /docker-init|tini/, 'reaping init must be PID1');
      assert.throws(() => execFileSync('chroot', ['/', '/bin/true'], {
        encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' },
      }), error => error.status === 1 && /Operation not permitted/.test(error.stderr),
      'the seccomp chroot exception must not grant chroot in the container namespace');
    }
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
  const spawn = childProcess.spawn;
  const connect = chromium.connect.bind(chromium);
  try {
    // Each variant launches the actual renderer. Observation delegates to real
    // Chromium and adds no production hook or access to renderer private state.
    for (const value of inShippingContainer ? [undefined] : [undefined, '0', 'false', '1', 'true']) {
      await t.test(`CHROMIUM_NO_SANDBOX=${value ?? '(unset)'}`, async t => {
        const disabled = value === '1' || value === 'true';
        let browser;
        let worker;
        t.mock.method(childProcess, 'spawn', function (...args) {
          const child = spawn.apply(this, args);
          if (args[1]?.some(arg => String(arg).endsWith('/browser-worker.js'))) worker = child;
          return child;
        });
        t.mock.method(chromium, 'connect', async (...args) => {
          browser = await connect(...args);
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
          assert.ok(worker?.pid, 'actual renderer owns its browser worker before connecting');
          const pgid = Number(execFileSync('ps', ['-p', String(browserPid), '-o', 'pgid='], { encoding: 'utf8', timeout: 5000 }).trim());
          assert.equal(pgid, worker.pid, 'actual browser remains in the owned worker group');
          const record = { value: value ?? '(unset)', workerPid: worker.pid, browserGroup: pgid, args, chromium: browser.version() };
          evidence.cases.push(record);
          // Assert actual process arguments first: this catches Playwright's
          // implicit --no-sandbox even across the private worker boundary.
          assert.equal(args.includes('--no-sandbox'), disabled);
          if (!disabled) {
            for (const flag of ['--disable-namespace-sandbox', '--disable-seccomp-filter-sandbox', '--single-process']) {
              assert.ok(!args.includes(flag), `unexpected ${flag}`);
            }
          }
          // Keep a real document alive for process inspection in this same
          // browser; renderQuestion closes its own page after capturing it.
          const witness = await browser.contexts()[0].newPage();
          await witness.goto(`${base}/api/get-header-html/1`);
          const live = await session.send('SystemInfo.getProcessInfo');
          record.processGroups = [];
          for (const child of live.processInfo) {
            const group = Number(execFileSync('ps', ['-p', String(child.id), '-o', 'pgid='], { encoding: 'utf8', timeout: 5000 }).trim());
            assert.equal(group, worker.pid, `actual ${child.type} remains in the owned worker group`);
            record.processGroups.push({ pid: child.id, type: child.type, group });
          }
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
            if (inShippingContainer) {
              for (const child of record.renderers) {
                for (const parent of [record.browser, evidence.parent]) {
                  assert.ok(child.seccompFilters > parent.seccompFilters, 'Chromium must add a filter beyond the container baseline');
                }
              }
            } else {
              assert.equal(evidence.parent.seccomp, '0', 'native CI proof must not rely on inherited container seccomp');
            }
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
  const folder = await mkdtemp(join(tmpdir(), 'scanner-sandbox-failure-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const preload = join(folder, 'fail-launch.mjs');
  const attempts = join(folder, 'attempts.jsonl');
  await writeFile(preload, `
    import cp from 'node:child_process';
    import { appendFileSync } from 'node:fs';
    if (process.argv[1]?.endsWith('/browser-worker.js')) {
      const spawn = cp.spawn;
      cp.spawn = function (command, args, options) {
        appendFileSync(${JSON.stringify(attempts)}, JSON.stringify(args) + '\\n');
        return spawn.call(this, '/nonexistent/scanner-synthetic-chromium', args, options);
      };
    }
  `);
  const options = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--import=${preload}`;
  t.after(() => { if (options === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = options; });
  const cfg = buildConfig({
    ADAPT_BASE_URL: 'http://127.0.0.1', ADAPT_TOKEN: 'synthetic-token',
    SCAN_MODE: 'http', REMEDY_ENDPOINT: 'http://127.0.0.1/unused', REMEDY_API_KEY: 'synthetic-key',
  });
  const renderer = new AdaptRenderer(cfg);
  try {
    await assert.rejects(renderer.init(), /Chromium launch failed/);
    const launches = (await readFile(attempts, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(launches.length, 1, 'OS launch failure must not trigger a retry');
    assert.ok(!launches[0].includes('--no-sandbox'), 'failed launch kept the sandbox enabled');
  } finally { await renderer.close(); }
});
