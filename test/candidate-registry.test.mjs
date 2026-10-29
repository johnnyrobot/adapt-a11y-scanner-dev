import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUnusedTag, observeVisibility } from '../.github/scripts/candidate-registry.mjs';

const tag = `non-release-${'a'.repeat(40)}-${'b'.repeat(64)}`;
const digest = `sha256:${'c'.repeat(64)}`;
const token = () => new Response(JSON.stringify({ token: 'synthetic-registry-token' }), { status: 200 });
const response = status => new Response(null, { status });
const denied = () => new Response(JSON.stringify({ errors: [{ code: 'DENIED' }] }), { status: 403 });
function registry(responses) {
  const calls = [];
  const fetch = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://ghcr.io');
    assert.equal(options.redirect, 'error');
    calls.push({ url: String(url), ...options });
    assert.ok(responses.length, 'no unexpected registry request');
    return responses.shift();
  };
  return { fetch, calls };
}

test('authenticated missing tag permits publication and requests pull plus push scope', async () => {
  const r = registry([token(), response(404)]);
  await assertUnusedTag(tag, r.fetch, 'synthetic-github-token');
  assert.equal(new URL(r.calls[0].url).searchParams.get('scope'), 'repository:johnnyrobot/adapt-a11y-scanner-dev-candidate:pull,push');
  assert.equal(r.calls[1].method, 'HEAD');
  assert.ok(r.calls[1].url.endsWith(`/manifests/${tag}`));
  assert.equal(r.calls[1].headers.Authorization, 'Bearer synthetic-registry-token');
});

test('authenticated existing tag refuses overwrite even when package is private', async () => {
  const r = registry([token(), response(200)]);
  await assert.rejects(assertUnusedTag(tag, r.fetch, 'synthetic-github-token'), /already exists/);
});

for (const status of [401, 403, 500]) {
  test(`registry access failure ${status} cannot masquerade as a missing tag`, async () => {
    const r = registry([token(), response(status)]);
    await assert.rejects(assertUnusedTag(tag, r.fetch, 'synthetic-github-token'), /tag lookup failed/);
  });
}

test('denied ephemeral token exchange stops before any tag lookup', async () => {
  const r = registry([response(403)]);
  await assert.rejects(assertUnusedTag(tag, r.fetch, 'synthetic-github-token'), /token exchange failed/);
  assert.equal(r.calls.length, 1);
});

test('private visibility requires authenticated manifest success and anonymous denial', async () => {
  const r = registry([token(), response(200), denied()]);
  assert.equal(await observeVisibility(digest, r.fetch, 'synthetic-github-token'), 'private');
  assert.equal(r.calls[2].headers.Authorization, undefined);
});

test('public visibility requires a successful anonymous manifest read', async () => {
  const r = registry([token(), response(200), token(), response(200)]);
  assert.equal(await observeVisibility(digest, r.fetch, 'synthetic-github-token'), 'public');
  assert.equal(r.calls[2].headers.Authorization, undefined);
  assert.equal(r.calls[3].headers.Authorization, 'Bearer synthetic-registry-token');
});

test('anonymous server errors cannot become a private visibility claim', async () => {
  const r = registry([token(), response(200), response(500)]);
  await assert.rejects(observeVisibility(digest, r.fetch, 'synthetic-github-token'), /anonymous token exchange failed/);
});

test('an inaccessible authenticated digest cannot claim either visibility', async () => {
  const r = registry([token(), response(404)]);
  await assert.rejects(observeVisibility(digest, r.fetch, 'synthetic-github-token'), /authenticated manifest lookup failed/);
});

test('anonymous generic forbidden response cannot become a private visibility claim', async () => {
  const r = registry([token(), response(200), response(403)]);
  await assert.rejects(observeVisibility(digest, r.fetch, 'synthetic-github-token'), /anonymous token exchange failed/);
});

test('private manifest denial after anonymous token issuance is explicit', async () => {
  const r = registry([token(), response(200), token(), denied()]);
  assert.equal(await observeVisibility(digest, r.fetch, 'synthetic-github-token'), 'private');
  assert.equal(r.calls[3].method, 'GET');
});
