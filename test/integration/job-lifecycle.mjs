import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pass = JSON.parse(readFileSync(new URL('../fixtures/contracts/v1/remedy-html-validation.json', import.meta.url))).examples.find(e => e.name === 'pass').body;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate, timeout = 6000) {
  const end = Date.now() + timeout;
  while (!predicate()) { assert.ok(Date.now() < end, 'fixture observation timed out'); await pause(20); }
}

async function harness(t, env = {}) {
  const calls = [];
  const observedOwned = new Set();
  let handler = (req, res) => {
    if (req.url.includes('/get-header-html/')) { res.setHeader('content-type','text/html'); res.end('<!doctype html><title>Synthetic</title><p>Fixture</p>'); }
    else if (req.url.includes('/questions/view/')) { res.setHeader('content-type','text/html');res.end(`<!doctype html><title>Fixture SPA</title><iframe src="/api/get-header-html/${req.url.split('/').pop()}"></iframe>`); }
    else if (req.url.includes('/questions/ids')) res.end(JSON.stringify({type:'success', question_ids_array:[1,2]}));
    else if (req.url === '/login') res.end('<!doctype html><title>Login fixture</title>');
    else if (req.url === '/api/login') res.end(JSON.stringify({token:'synthetic-token'}));
    else res.end(JSON.stringify(pass));
  };
  const fixture = createServer((req,res) => {
    calls.push(req.url); descendants();
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path.startsWith('/mathjax/')) {
      try {
        const asset = readFileSync(new URL('../../node_modules/mathjax/' + path.slice('/mathjax/'.length), import.meta.url));
        res.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'); res.end(asset);
      } catch { res.writeHead(404).end(); }
      return;
    }
    handler(req,res);
  });
  fixture.listen(0,'127.0.0.1'); await once(fixture,'listening');
  const base = `http://127.0.0.1:${fixture.address().port}`;
  const api = spawn(process.execPath,['dist/server.js'], {env:{...process.env,DOTENV_CONFIG_PATH:'/dev/null',ADAPT_BASE_URL:base,ADAPT_TOKEN:'synthetic-token',ADAPT_EMAIL:'',ADAPT_PASSWORD:'',REMEDY_ENDPOINT:`${base}/validate`,REMEDY_API_KEY:'synthetic-key',SCAN_MODE:'http',RENDER_MODE:'iframe',CHROMIUM_NO_SANDBOX:'0',SCANNER_API_KEY:'synthetic-key',SCANNER_HOST:'127.0.0.1',SCANNER_PORT:'0',SCANNER_MAX_ACTIVE_JOBS:'1',SCANNER_MAX_QUEUED_JOBS:'1',SCANNER_JOB_TIMEOUT_MS:'20000',NAV_TIMEOUT_MS:'15000',MATHJAX_TIMEOUT_MS:'15000',REMEDY_TIMEOUT_MS:'15000',...env},stdio:['ignore','pipe','pipe']});
  let output='',errors=''; api.stdout.on('data', d => output+=d); api.stderr.on('data',d => errors+=d);
  await until(()=>output.includes('listening') || api.exitCode!==null);
  assert.equal(api.exitCode,null,errors);
  const endpoint = output.match(/http:\/\/127\.0\.0\.1:(\d+)/)[0];
  const post = (id=1, mode='question') => fetch(`${endpoint}/v1/adapt/scan`,{method:'POST',headers:{'x-api-key':'synthetic-key','content-type':'application/json'},body:JSON.stringify({mode,id,assignmentId:42}),signal:AbortSignal.timeout(25000)});
  const disconnect = (id=1,mode='question') => {
    const req=request(`${endpoint}/v1/adapt/scan`,{method:'POST',headers:{'x-api-key':'synthetic-key','content-type':'application/json'}});
    req.on('error',()=>{}); req.end(JSON.stringify({mode,id,assignmentId:42})); return req;
  };
  t.after(async()=> {if(api.exitCode===null && api.signalCode===null){const exit=once(api,'exit');api.kill('SIGTERM');await exit;} fixture.closeAllConnections();await new Promise(r=>fixture.close(r));});
  const processRows = () => execFileSync('ps',['-A','-o','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(l=>l.trim().split(/\s+/).map(Number));
  const browserPids = () => processRows().filter(([,parent])=>parent===api.pid).map(([pid])=>pid);
  const descendants = () => {
    const rows=processRows();
    const owned=new Set([api.pid]);
    for(let changed=true;changed;){changed=false;for(const [pid,parent] of rows)if(owned.has(parent)&&!owned.has(pid)){owned.add(pid);changed=true;}}
    owned.delete(api.pid);for(const pid of owned)observedOwned.add(pid);return [...owned];
  };
  const assertExited = async pids => {
    await until(()=>pids.every(pid=>{try{process.kill(pid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw e;}}));
  };
  t.after(async()=>{await assertExited([...observedOwned]);});
  return {calls,api,post,disconnect,base,endpoint,descendants,assertExited,browserPids,setHandler: h=>handler=h,defaultHandler:handler};
}

test('actual HTTP admission limits browser work and frees disconnected queued jobs', {timeout:30000}, async t=>{
  const h=await harness(t);
  h.setHandler((req,res)=> {if(req.url.includes('/get-header-html/1')) return;h.defaultHandler(req,res);});
  const first=h.disconnect(); await until(()=>h.calls.includes('/api/get-header-html/1'));
  const queued=h.disconnect(2); await pause(100);
  const overloaded=await h.post(3);
  assert.equal(overloaded.status,503);assert.equal(overloaded.headers.get('retry-after'),'5');
  assert.deepEqual(h.calls,['/api/get-header-html/1']);
  queued.destroy();await pause(100);
  const replacement=h.post(4);
  first.destroy();
  const report=await replacement;assert.equal(report.status,200);assert.equal((await report.json()).ok,true);
  assert.ok(!h.calls.includes('/api/get-header-html/2'));assert.ok(!h.calls.includes('/api/get-header-html/3'));
});

for (const phase of ['login navigation','login fetch','enumeration','question navigation','frame readiness','math readiness','validation','retry sleep','login response body','enumeration response body','validation response body']) {
  test(`disconnect cancels actual ${phase} and prevents later downstream calls`, {timeout:15000}, async t=>{
    const login=phase.startsWith('login');
    const h=await harness(t,{...(login?{ADAPT_TOKEN:'',ADAPT_EMAIL:'synthetic@example.invalid',ADAPT_PASSWORD:'synthetic-password'}:{}),...(phase==='frame readiness'?{RENDER_MODE:'spa'}:{})});
    let reached=false, bodyClosed=false;
    h.setHandler((req,res)=>{
      const path=req.url;
      if ((phase === 'login response body' && path === '/api/login') ||
          (phase === 'enumeration response body' && path.includes('/questions/ids')) ||
          (phase === 'validation response body' && path === '/validate')) {
        reached = true; res.once('close', () => { bodyClosed = true; });
        res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"partial":'); return;
      }
      const stop=(phase==='login navigation'&&path==='/login') || (phase==='login fetch'&&path==='/api/login') || (phase==='enumeration'&&path.includes('/questions/ids')) || (phase==='question navigation'&&path.includes('/get-header-html/1')) || (phase==='validation'&&path==='/validate');
      if(stop){reached=true;return;}
      if(phase==='frame readiness'&&path.includes('/questions/view/')){reached=true;res.setHeader('content-type','text/html');res.end('<!doctype html><title>Synthetic SPA without question frame</title>');return;}
      if (phase === 'math readiness' && path.includes('/get-header-html/1')) {
        reached = true; res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><title>Synthetic pending real math</title><p>\\(x\\)</p><script>window.MathJax={delayStartupUntil:"configured"}</script><script src="/mathjax/MathJax.js?config=TeX-AMS_HTML"></script>'); return;
      }
      if(phase==='retry sleep'&&path==='/validate'){reached=true;res.writeHead(429,{'retry-after':'60'});res.end('{}');return;}
      h.defaultHandler(req,res);
    });
    const req=phase==='frame readiness'
      ? (()=>{const r=request(`${h.endpoint}/v1/adapt/scan`,{method:'POST',headers:{'x-api-key':'synthetic-key','content-type':'application/json'}});r.on('error',()=>{});r.end(JSON.stringify({mode:'question',id:1,assignmentId:42}));return r;})()
      :h.disconnect(phase.startsWith('enumeration')?42:1,phase.startsWith('enumeration')?'assignment':'question');
    await until(()=>reached);
    if(['math readiness','frame readiness','retry sleep'].includes(phase))await pause(650);
    if (phase === 'math readiness') assert.ok(h.calls.some(path => path.startsWith('/mathjax/MathJax.js')), 'actual pinned loader requested');
    const previous=[...h.calls];
    const owned=h.descendants();assert.ok(owned.length>0);
    req.destroy();
    if (phase.endsWith('response body')) await until(() => bodyClosed);
    // A successful next request proves actual capacity has been released.
    h.setHandler(h.defaultHandler);
    await pause(150);
    const next=await h.post(3);assert.equal(next.status,200);assert.equal((await next.json()).ok,true);
    await h.assertExited(owned);
    const after=h.calls.slice(previous.length);
    assert.ok(!after.includes('/api/get-header-html/2'));
    assert.equal(after.filter(p=>p==='/validate').length,1,'cancelled job must not submit or retry validation');
    await pause(150);assert.deepEqual(h.calls.slice(previous.length),after,'no late downstream activity');
  });
}

test('one deadline covers a Retry-After delay without another attempt', {timeout:15000},async t=>{
  const h=await harness(t,{SCANNER_JOB_TIMEOUT_MS:'1600'});
  h.setHandler((req,res)=>{if(req.url==='/validate'){res.writeHead(429,{'retry-after':'60'});res.end('{}');}else h.defaultHandler(req,res);});
  const start=Date.now();const response=await h.post();const body=await response.json();
  assert.equal(response.status,504);assert.equal(body.ok,false);assert.match(body.error,/deadline/);
  assert.ok(Date.now()-start<3000);assert.equal(h.calls.filter(p=>p==='/validate').length,1);
  await pause(200);assert.equal(h.calls.filter(p=>p==='/validate').length,1);
});

test('queued deadline expiry does no browser navigation or validation work', {timeout:15000},async t=>{
  const h=await harness(t,{SCANNER_JOB_TIMEOUT_MS:'1300'});
  h.setHandler((req,res)=>{if(req.url.includes('/get-header-html/1'))return;h.defaultHandler(req,res);});
  const first=h.post(1);const queued=h.post(2);
  const responses=await Promise.all([first,queued]);
  for(const response of responses){assert.equal(response.status,504);assert.match((await response.json()).error,/deadline/);}
  assert.deepEqual(h.calls,['/api/get-header-html/1']);
});

test('shutdown cancels active validation and queued work, drains within 15 seconds',{timeout:20000},async t=>{
  const h=await harness(t);let reached=false;
  h.setHandler((req,res)=>{if(req.url==='/validate'){reached=true;return;}h.defaultHandler(req,res);});
  const active=h.post();await until(()=>reached);const queued=h.post(2);await pause(50);
  const exit=once(h.api,'exit');const start=Date.now();h.api.kill('SIGTERM');
  const responses=await Promise.all([active,queued]);
  for(const response of responses){assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'5');assert.equal((await response.json()).ok,false);}
  const [code]=await exit;assert.equal(code,0);assert.ok(Date.now()-start<15000);
  const calls=[...h.calls];await pause(200);assert.deepEqual(h.calls,calls);assert.ok(!calls.includes('/api/get-header-html/2'));
});

test('shutdown readiness and admission stop while a stuck owned browser is killed after cleanup grace', {timeout:18000},async t=>{
  const h=await harness(t);let reached=false;
  h.setHandler((req,res)=>{if(req.url==='/validate'){reached=true;return;}h.defaultHandler(req,res);});
  const active=h.post();await until(()=>reached);const queued=h.post(2);await pause(50);
  const browser=h.browserPids()[0];assert.ok(browser);const owned=h.descendants();
  // Stop the synthetic browser, not the scanner: cooperative close now cannot
  // complete, exercising production's owned-process escalation without a mock.
  process.kill(browser,'SIGSTOP');
  const exited=once(h.api,'exit');const start=Date.now();h.api.kill('SIGTERM');await pause(100);
  const health=await fetch(`${h.endpoint}/healthz`);assert.equal(health.status,503);assert.equal((await health.json()).ok,false);
  const overload=await h.post(3);assert.equal(overload.status,503);assert.equal(overload.headers.get('retry-after'),'5');
  assert.deepEqual(h.calls.filter(p=>p.includes('/get-header-html/')),['/api/get-header-html/1']);
  const responses=await Promise.all([active,queued]);
  for(const response of responses){assert.equal(response.status,503);assert.equal((await response.json()).ok,false);}
  const [code]=await exited;assert.equal(code,0);const elapsed=Date.now()-start;
  assert.ok(elapsed>=4800 && elapsed<15000,`cleanup/shutdown elapsed ${elapsed}ms`);
  await h.assertExited(owned);assert.equal(h.calls.filter(p=>p==='/validate').length,1);
});

test('shutdown during login is an explicit unsuccessful 503, not a deadline or question report',{timeout:10000},async t=>{
  const h=await harness(t,{ADAPT_TOKEN:'',ADAPT_EMAIL:'synthetic@example.invalid',ADAPT_PASSWORD:'synthetic-password'});let reached=false;
  h.setHandler((req,res)=>{if(req.url==='/api/login'){reached=true;return;}h.defaultHandler(req,res);});
  const active=h.post();await until(()=>reached);h.api.kill('SIGTERM');
  const response=await active;assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'5');
  const body=await response.json();assert.equal(body.ok,false);assert.match(body.error,/shutting down/);assert.equal(body.results,undefined);
  assert.ok(!h.calls.some(p=>p.includes('get-header-html')));
});

test('disconnect retains the actual slot through forced browser cleanup before starting queued work', {timeout:18000},async t=>{
  const h=await harness(t);let reached=false;
  h.setHandler((req,res)=>{if(req.url==='/validate'){reached=true;return;}h.defaultHandler(req,res);});
  const active=h.disconnect();await until(()=>reached);
  const browser=h.browserPids()[0];assert.ok(browser);const owned=h.descendants();process.kill(browser,'SIGSTOP');
  const start=Date.now();active.destroy();const queued=h.post(2);await pause(150);
  const overloaded=await h.post(3);assert.equal(overloaded.status,503);assert.equal(overloaded.headers.get('retry-after'),'5');
  assert.deepEqual(h.calls.filter(p=>p.includes('/get-header-html/')),['/api/get-header-html/1']);
  h.setHandler(h.defaultHandler);
  const response=await queued;assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
  assert.ok(Date.now()-start>=4800);await h.assertExited(owned);
  assert.equal(h.calls.filter(p=>p.includes('/get-header-html/2')).length,1);
  assert.equal(h.calls.filter(p=>p.includes('/get-header-html/3')).length,0);
});

test('deadline closes a partial incoming upload and releases capacity without browser work', { timeout: 8000 }, async t => {
  const h = await harness(t, { SCANNER_JOB_TIMEOUT_MS: '500' });
  const upload = request(`${h.endpoint}/v1/adapt/scan`, { method: 'POST', headers: {
    'x-api-key': 'synthetic-key', 'content-type': 'application/json', 'content-length': '10000',
  } });
  upload.on('error', () => {});
  let closed = false; upload.once('close', () => { closed = true; });
  const responded = once(upload, 'response');
  upload.write('{"mode":');
  const [response] = await responded;
  let body = ''; for await (const chunk of response) body += chunk;
  assert.equal(response.statusCode, 504); assert.equal(JSON.parse(body).ok, false);
  assert.equal(response.headers.connection, 'close'); await until(() => closed);
  assert.deepEqual(h.calls, []); assert.deepEqual(h.browserPids(), []);
  // Another body can be admitted immediately; invalid JSON stays a client error.
  const next = await fetch(`${h.endpoint}/v1/adapt/scan`, { method: 'POST', headers: { 'x-api-key': 'synthetic-key' }, body: '{' });
  assert.equal(next.status, 400); assert.deepEqual(h.calls, []);
});
