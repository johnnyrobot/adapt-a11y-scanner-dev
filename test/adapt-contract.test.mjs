import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { listAssignmentQuestions } from '../dist/adapt-client.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/contracts/v1/adapt-assignment-ids.json', import.meta.url)));

async function withAdapt(body, run) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/questions/ids') ? body : { type: 'success', assignment: { name: 'Metadata only' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`, requests); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
}

test('enumerates source-backed question IDs rather than assignment metadata', async () => {
  await withAdapt(fixture.examples[0].body, async (base, requests) => {
    assert.deepEqual(await listAssignmentQuestions(base, 'synthetic-token', 42), [{ id: 7 }, { id: '9007199254740993' }]);
    assert.deepEqual(requests, [{ path: '/api/assignments/42/questions/ids', auth: 'Bearer synthetic-token' }]);
  });
});

test('recognized empty array is retained, legacy duplicate never supplies the list', async () => {
  await withAdapt({ type: 'success', question_ids_array: [], question_ids: '[999]' }, async base => {
    assert.deepEqual(await listAssignmentQuestions(base, 'synthetic-token', '0042'), []);
  });
});

test('malformed, unknown and application-error envelopes are rejected as contracts', async () => {
  const bodies = [null, [], {}, { type: 'error', question_ids_array: [] }, { type: 'success', question_ids: '[7]' }, { questions: [{ id: 7 }] }, { question_info: [] }, { data: [] }, { type: 'success', question_ids_array: {} }];
  for (const body of bodies) {
    await withAdapt(body, async base => {
      await assert.rejects(listAssignmentQuestions(base, 'synthetic-token', 42), /contract/);
    });
  }
});

test('a malformed ID rejects the whole list instead of filtering or coercing', async () => {
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, true, {}, '0', '000', '-1', '1.5', '1e3', ' 1', '../7']) {
    await withAdapt({ type: 'success', question_ids_array: [7, id] }, async base => {
      await assert.rejects(listAssignmentQuestions(base, 'synthetic-token', 42), /contract/);
    });
  }
  await assert.rejects(listAssignmentQuestions('http://127.0.0.1:1', 'synthetic-token', '../42'), /positive integer/);
});
