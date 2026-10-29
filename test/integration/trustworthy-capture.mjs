import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { runAdaptScan } from '../../dist/job.js';
import { AdaptRenderer } from '../../dist/renderer.js';
import { buildConfig } from '../../dist/config.js';

const contract = JSON.parse(await readFile(new URL('../fixtures/contracts/v1/remedy-html-validation.json', import.meta.url)));
const pass = contract.examples.find(e => e.name === 'pass').body;
// Lockfile pins the entire archive; these independent asset digests catch fixture drift.
for (const [path, digest] of [
  ['MathJax.js', 'f3bbf1b342e93173df117394fed9b914afc1506eee6c04b92edb528d09893048'],
  ['config/TeX-AMS_HTML.js', '02a6199a83a04869684c04bad7cdbb250aa620eb263991ce8031d585dfc8dde3'],
  ['LICENSE', 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'],
]) assert.equal(createHash('sha256').update(await readFile(new URL('../../node_modules/mathjax/' + path, import.meta.url))).digest('hex'), digest);


test('trustworthy capture through actual Chromium and scan job', { timeout: 90000 }, async t => {
  let status = 200, redirect, validations = 0, captured = '', document = '<p>Synthetic no-math question</p>', framePath = '/api/get-header-html/7', outerForm = '', disguise = false;
  const assetRoot = resolve('node_modules/mathjax');
  const fixture = createServer(async (req, res) => {
    if (req.url.startsWith('/mathjax/')) {
      const path = resolve(assetRoot, new URL(req.url, 'http://fixture').pathname.slice('/mathjax/'.length));
      if (!path.startsWith(assetRoot + sep)) { res.writeHead(400).end(); return; }
      try {
        const data = await readFile(path);
        res.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'); res.end(data);
      } catch { res.writeHead(404).end(); }
      return;
    }
    if (disguise && req.url.startsWith('/login')) {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<script>history.replaceState(null,"","/api/get-header-html/7")</script><p>Unexpected document</p>'); return;
    }
    if (req.url === '/validate') {
      validations++; captured = '';
      for await (const chunk of req) captured += chunk;
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(pass));
    } else if (req.url === '/assignments/42/questions/view/7') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(`${outerForm}<iframe src="${framePath}"></iframe>`);
    } else if (req.url === '/api/get-header-html/7') {
      if (redirect && req.headers.host.startsWith('127.0.0.1')) { res.writeHead(302, { location: redirect }).end(); return; }
      res.writeHead(status, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html lang="en"><title>Question</title><body>${document}</body></html>`);
    } else { res.writeHead(200, { 'content-type': 'text/html' }).end('<p>Wrong document</p>'); }
  });
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
  const base = `http://127.0.0.1:${fixture.address().port}`;
  const env = { ADAPT_BASE_URL: base, ADAPT_TOKEN: 'synthetic-token', SCAN_MODE: 'http', RENDER_MODE: 'iframe', REMEDY_ENDPOINT: `${base}/validate`, REMEDY_API_KEY: 'synthetic-key', CHROMIUM_NO_SANDBOX: '0', NAV_TIMEOUT_MS: '2500', MATHJAX_TIMEOUT_MS: '1500', REMEDY_TIMEOUT_MS: '1000' };
  const original = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  const mathDocument = (config = '', suffix = '', source = String.raw`<p>\(x^2+1\)</p><math><mfrac><mn>1</mn><mn>2</mn></mfrac></math>`) => `
    <script>window.MathJax={${config}}</script>
    <script type="text/x-mathjax-config">
      MathJax.Hub.Config({ messageStyle:'none', menuSettings:{renderer:'SVG'}, jax:['input/TeX','input/MathML','output/SVG'], extensions:['tex2jax.js','mml2jax.js'], ${config} });
    </script>${source}<script src="/mathjax/MathJax.js?config=TeX-AMS_HTML"></script>${suffix}`;
  const scan = () => runAdaptScan({ mode: 'question', id: 7, assignmentId: 42 });
  try {
    await t.test('HTTP error documents never reach validation', async () => {
      for (status of [401, 403, 404, 500]) {
        const report = await scan();
        assert.equal(report.exitCode, 1); assert.equal(report.totals.scanned, 0); assert.equal(report.totals.failed, 1);
        assert.match(report.results[0].error, new RegExp(`capture.*${status}`));
        assert.equal(validations, 0);
      }
    });
    await t.test('CLI rejects an HTTP error question with an unsuccessful report', async () => {
      const child = spawn(process.execPath, ['dist/index.js', 'question', '7'], {
        env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      try {
        const [code] = await once(child, 'close');
        assert.equal(code, 1, stderr);
        const report = JSON.parse(stdout); assert.equal(report.totals.scanned, 0); assert.equal(report.totals.failed, 1);
        assert.match(report.results[0].error, /capture.*500/); assert.equal(validations, 0);
      } finally { clearTimeout(timer); }
    });
    status = 200;
    await t.test('redirects to login, another question and another origin fail closed', async () => {
      for (redirect of ['/login?token=do-not-report', '/api/get-header-html/8', 'http://localhost:' + fixture.address().port + '/api/get-header-html/7']) {
        const report = await scan();
        assert.equal(report.exitCode, 1); assert.equal(report.totals.scanned, 0);
        assert.match(report.results[0].error, /capture/); assert.doesNotMatch(report.results[0].error, /do-not-report/);
        assert.equal(validations, 0);
      }
      redirect = undefined;
    });
    await t.test('a redirected document cannot hide its response identity with browser history', async () => {
      const before = validations; redirect = '/login'; disguise = true;
      try { const report = await scan(); assert.equal(report.exitCode, 1); assert.equal(validations, before); }
      finally { redirect = undefined; disguise = false; }
    });
    await t.test('valid no-math iframe and SPA captures reach validation', async () => {
      const before = validations;
      for (const mode of ['iframe', 'spa']) {
        process.env.RENDER_MODE = mode;
        const report = await scan();
        assert.equal(report.exitCode, 0, report.results[0]?.error);
        assert.match(captured, /Synthetic no-math question/); captured = '';
      }
      process.env.RENDER_MODE = 'iframe';
      assert.equal(validations, before + 2);
    });
    await t.test('SPA final content-frame status and identity are checked', async () => {
      const before = validations; process.env.RENDER_MODE = 'spa';
      try {
      for (const code of [401, 403, 404, 500]) {
        status = code;
        const report = await scan(); assert.equal(report.exitCode, 1); assert.equal(report.totals.scanned, 0);
      }
      status = 200; framePath = '/api/get-header-html/8';
      const report = await scan(); assert.equal(report.exitCode, 1); assert.equal(validations, before);
      } finally { framePath = '/api/get-header-html/7'; process.env.RENDER_MODE = 'iframe'; }
    });
    await t.test('outer SPA authentication documents fail even with a valid question frame', async () => {
      process.env.RENDER_MODE = 'spa'; outerForm = '<form><input type="password"></form>';
      const before = validations;
      try {
        const report = await scan(); assert.equal(report.exitCode, 1); assert.equal(validations, before);
      } finally { outerForm = ''; process.env.RENDER_MODE = 'iframe'; }
    });
    await t.test('known math without a completing library is a readiness failure', async () => {
      const before = validations;
      document = String.raw`<p>\(x^2+1\)</p>`;
      const report = await scan();
      assert.equal(report.exitCode, 1); assert.equal(report.totals.scanned, 0);
      assert.match(report.results[0].error, /readiness/); assert.equal(validations, before);
    });
    await t.test('actual pinned MathJax typesets TeX and MathML in iframe and SPA', async () => {
      document = mathDocument();
      for (const mode of ['iframe', 'spa']) {
        process.env.RENDER_MODE = mode;
        const report = await scan();
        assert.equal(report.exitCode, 0, report.results[0]?.error);
        assert.ok(captured.includes('<svg'), 'actual captured SVG required'); assert.match(captured, /MathJax-Element-2-Frame/); captured = '';
      }
      process.env.RENDER_MODE = 'iframe';
    });
    await t.test('delayed official startup and idle-before-typeset complete real rendering', async () => {
      for (const [config, suffix] of [
        ["delayStartupUntil:'configured'", '<script>setTimeout(()=>MathJax.Hub.Configured(),900)</script>'],
        ['skipStartupTypeset:true', ''],
      ]) {
        document = mathDocument(config, suffix);
        const report = await scan(); assert.equal(report.exitCode, 0, report.results[0]?.error);
        assert.ok(captured.includes('<svg'), 'actual captured SVG required'); captured = '';
      }
    });
    await t.test('ADAPT default output selection also produces completed real math', async () => {
      document = mathDocument().replace("menuSettings:{renderer:'SVG'},", '');
      const report = await scan(); assert.equal(report.exitCode, 0, report.results[0]?.error);
      assert.ok(captured.includes('id="MathJax-Element-2-Frame"'), 'both real math sources rendered'); captured = '';
    });
    await t.test('completed real CommonHTML output is accepted', async () => {
      document = mathDocument().replace("menuSettings:{renderer:'SVG'}", "menuSettings:{renderer:'CommonHTML'}");
      const report = await scan(); assert.equal(report.exitCode, 0, report.results[0]?.error);
      assert.ok(/class="[^"]*MathJax_CHTML/.test(captured), 'actual CommonHTML output required'); captured = '';
    });
    await t.test('declared configuration waits for a delayed actual loader', async () => {
      document = mathDocument().replace('<script src="/mathjax/MathJax.js?config=TeX-AMS_HTML"></script>',
        '<script>setTimeout(()=>{const s=document.createElement("script");s.src="/mathjax/MathJax.js?config=TeX-AMS_HTML";document.head.append(s)},900)</script>');
      const report = await scan(); assert.equal(report.exitCode, 0, report.results[0]?.error);
      assert.ok(captured.includes('<svg'), 'actual captured SVG required'); captured = '';
    });
    await t.test('declared loader with no math must still finish supported startup', async () => {
      document = mathDocument('', '', '<p>No math with a loader</p>');
      const report = await scan(); assert.equal(report.exitCode, 0, report.results[0]?.error);
    });
    await t.test('page-controlled timers cannot suppress the host math deadline or block the next question', async () => {
      document = mathDocument("delayStartupUntil:'configured'", '<script>window.setTimeout=()=>0</script>');
      const renderer = new AdaptRenderer(buildConfig(env));
      await renderer.init();
      // Teardown guard makes the old bug fail without leaking its actual browser.
      const guard = setTimeout(() => { void renderer.close(); }, 5000);
      try {
        const started = Date.now();
        await assert.rejects(renderer.renderQuestion(7), /readiness/);
        assert.ok(Date.now() - started < 4000, 'host math deadline must end actual page work');
        clearTimeout(guard); document = '<p>Next valid question</p>';
        const next = await renderer.renderQuestion(7); assert.match(next.html, /Next valid question/);
      } finally { clearTimeout(guard); await renderer.close(); }
    });
    await t.test('extension load failure before observation cannot become a clean no-math capture', async () => {
      const before = validations;
      document = mathDocument('', '', '<p>Declared library, no math</p>').replace("extensions:['tex2jax.js','mml2jax.js']", "extensions:['tex2jax.js','mml2jax.js','/mathjax/missing-optional.js']");
      const report = await scan(); assert.equal(report.exitCode, 1); assert.equal(validations, before);
      assert.match(report.results[0].error, /readiness/);
    });
    await t.test('busy, failed, unsupported and interrupted math never reaches validation', async t => {
      for (const [index, content] of [
        mathDocument('', '<script>MathJax.Hub.Register.StartupHook("End",function(){MathJax.Hub.Queue(function(){return MathJax.Callback({})})})</script>'),
        '<p>\\(x\\)</p><script src="/mathjax/missing.js"></script>',
        '<script>window.MathJax={version:"3.2.2"}</script><p>\\(x\\)</p>',
        mathDocument("delayStartupUntil:'configured'", '<script>setTimeout(()=>location.href="/login?token=do-not-report",900)</script>'),
        mathDocument('', '', '<p>\\(\\frac{\\)</p>'),
        '<span class="MathJax_CHTML">Saved math without its library</span>',
        mathDocument('', '', String.raw`<p>\(x\) then incomplete \(y</p>`),
      ].entries()) {
        await t.test(`math failure ${index}`, async () => {
        const before = validations; document = content;
        const report = await scan(); assert.equal(report.exitCode, 1, `case ${index}`); assert.equal(report.totals.scanned, 0);
        assert.match(report.results[0].error, /readiness/); assert.doesNotMatch(report.results[0].error, /do-not-report/);
        assert.equal(validations, before);
        });
      }
    });
  } finally {
    for (const [k, v] of Object.entries(original)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
  }
});
