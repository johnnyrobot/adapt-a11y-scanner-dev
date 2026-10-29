/**
 * listAssignmentQuestions must bound its request. Without a signal a stalled
 * ADAPT endpoint hangs the whole assignment batch, and because job.ts calls it
 * inside a try/finally it also delays renderer.close(). Run via `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { listAssignmentQuestions } from '../dist/adapt-client.js';

const okBody = JSON.stringify({ type: 'success', question_ids_array: [7] });

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test('passes an abort signal when a timeout is supplied', async () => {
  let seen;
  const restore = stubFetch(async (_url, init) => {
    seen = init;
    return { ok: true, status: 200, text: async () => okBody };
  });
  try {
    const refs = await listAssignmentQuestions('https://adapt.test', 'tok', 42, 5000);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].id, 7);
    assert.ok(seen.signal, 'expected an AbortSignal to be passed');
    assert.equal(typeof seen.signal.aborted, 'boolean');
  } finally {
    restore();
  }
});

test('omits the signal when no timeout is supplied', async () => {
  let seen;
  const restore = stubFetch(async (_url, init) => {
    seen = init;
    return { ok: true, status: 200, text: async () => okBody };
  });
  try {
    await listAssignmentQuestions('https://adapt.test', 'tok', 42);
    assert.equal(seen.signal, undefined);
  } finally {
    restore();
  }
});

test('converts an abort into a descriptive timeout error', async () => {
  const restore = stubFetch(async () => {
    const err = new Error('This operation was aborted');
    err.name = 'TimeoutError';
    throw err;
  });
  try {
    await assert.rejects(
      () => listAssignmentQuestions('https://adapt.test', 'tok', 42, 1234),
      /timed out after 1234ms/,
    );
  } finally {
    restore();
  }
});

test('propagates non-timeout fetch failures unchanged', async () => {
  const restore = stubFetch(async () => {
    throw new Error('ECONNREFUSED');
  });
  try {
    await assert.rejects(
      () => listAssignmentQuestions('https://adapt.test', 'tok', 42, 1000),
      /ECONNREFUSED/,
    );
  } finally {
    restore();
  }
});

test('surfaces a non-ok ADAPT response as an error', async () => {
  const restore = stubFetch(async () => ({
    ok: false, status: 503, text: async () => 'upstream unavailable',
  }));
  try {
    await assert.rejects(
      () => listAssignmentQuestions('https://adapt.test', 'tok', 42, 1000),
      /questions\/ids 503/,
    );
  } finally {
    restore();
  }
});
