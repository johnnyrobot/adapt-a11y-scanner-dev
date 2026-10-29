import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const endpoint = 'http://127.0.0.1:5176';
const until = async check => {
  const deadline = Date.now() + 10000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'actual shipping server/fixture did not become ready');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
await until(async () => { try { return (await fetch(`${endpoint}/healthz`)).ok; } catch { return false; } });
const post = id => fetch(`${endpoint}/v1/adapt/scan`, { method: 'POST',
  headers: { 'x-api-key': 'synthetic-key', 'content-type': 'application/json' },
  body: JSON.stringify({ mode: 'question', id }), signal: AbortSignal.timeout(25000) });
const active = post(1);
await until(async () => { try { await readFile('/evidence/stop-validation-reached'); return true; } catch { return false; } });
const queued = post(2);
await new Promise(resolve => setTimeout(resolve, 100));
const overload = await post(3); assert.equal(overload.status, 503);
await writeFile('/evidence/stop-ready', 'active validation and queued request\n');
const results = [];
for (const response of await Promise.all([active, queued])) {
  const body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.ok, false);
  assert.match(body.error, /shutting down/);
  results.push({ status: response.status, ok: body.ok, error: body.error });
}
await writeFile('/evidence/stop-client.json', JSON.stringify(results, null, 2));
