// Query GHCR itself: GitHub's user-package metadata endpoints describe public
// packages only. Never treat a hidden private package as an absent image tag.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const repository = 'johnnyrobot/adapt-a11y-scanner-dev-candidate';
const accept = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.docker.distribution.manifest.list.v2+json'].join(', ');
const request = (fetchImpl, url, options = {}) => fetchImpl(url, {
  ...options, redirect: 'error', signal: AbortSignal.timeout(15000),
});
const basic = credential => {
  assert.ok(credential, 'ephemeral GitHub token is required');
  return `Basic ${Buffer.from(`johnnyrobot:${credential}`).toString('base64')}`;
};
async function registryToken(fetchImpl, actions, authorization) {
  const url = new URL('https://ghcr.io/token');
  url.searchParams.set('service', 'ghcr.io');
  url.searchParams.set('scope', `repository:${repository}:${actions}`);
  const response = await request(fetchImpl, url.href, {
    headers: authorization ? { Authorization: authorization } : {},
  });
  if (response.status !== 200) return { status: response.status, denied: await accessDenied(response) };
  const body = await response.json();
  const token = body.token ?? body.access_token;
  assert.ok(typeof token === 'string' && token.length > 0, 'registry returned no token');
  return { status: 200, token };
}
async function accessDenied(response) {
  const body = await response.json().catch(() => ({}));
  return [401, 403].includes(response.status) && Array.isArray(body.errors) &&
    body.errors.some(error => ['DENIED', 'UNAUTHORIZED'].includes(error.code));
}
const manifest = (fetchImpl, reference, token, method = 'HEAD') => request(fetchImpl,
  `https://ghcr.io/v2/${repository}/manifests/${reference}`, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: accept },
  });

export async function assertUnusedTag(tag, fetchImpl = fetch, credential = process.env.GH_TOKEN) {
  assert.match(tag, /^non-release-[a-f0-9]{40}-[a-f0-9]{64}$/);
  // Request the same pull+push authority needed by publication, including when
  // this is the first package creation. An auth error is never absence.
  const auth = await registryToken(fetchImpl, 'pull,push', basic(credential));
  assert.equal(auth.status, 200, `registry token exchange failed (HTTP ${auth.status})`);
  const response = await manifest(fetchImpl, tag, auth.token);
  assert.notEqual(response.status, 200, 'candidate tag already exists; refusing overwrite');
  assert.equal(response.status, 404, `authenticated tag lookup failed (HTTP ${response.status})`);
}

export async function observeVisibility(digest, fetchImpl = fetch, credential = process.env.GH_TOKEN) {
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  const auth = await registryToken(fetchImpl, 'pull', basic(credential));
  assert.equal(auth.status, 200, `registry token exchange failed (HTTP ${auth.status})`);
  const authenticated = await manifest(fetchImpl, digest, auth.token);
  assert.equal(authenticated.status, 200, 'authenticated manifest lookup failed');
  const anonymous = await registryToken(fetchImpl, 'pull');
  // This fixed personal namespace has public/private visibility. First prove
  // that the exact digest exists with auth, then observe anonymous accessibility.
  if (anonymous.denied) return 'private';
  assert.equal(anonymous.status, 200, `anonymous token exchange failed (HTTP ${anonymous.status})`);
  const response = await manifest(fetchImpl, digest, anonymous.token, 'GET');
  if ([401, 403].includes(response.status) && await accessDenied(response)) return 'private';
  assert.equal(response.status, 200, 'anonymous manifest lookup failed');
  await response.body?.cancel();
  return 'public';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'preflight') await assertUnusedTag(process.argv[3]);
  else if (process.argv[2] === 'visibility') console.log(await observeVisibility(process.argv[3]));
  else throw new Error('unknown registry operation');
}
