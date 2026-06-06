/**
 * Tests for the renderer's security-relevant pure helpers:
 *  - isValidId: reject non-numeric ids that could forge authenticated ADAPT
 *    requests via path traversal (L4).
 *  - buildTokenCookie: the service-account JWT cookie must be httpOnly + secure
 *    + SameSite=Strict so rendered question JS can't read/exfiltrate it (H3),
 *    with secure relaxed only for localhost http dev.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidId, buildTokenCookie } from '../dist/renderer.js';

test('isValidId accepts numeric ids, rejects traversal/garbage (L4)', () => {
  assert.equal(isValidId(123), true);
  assert.equal(isValidId('456'), true);
  assert.equal(isValidId('../api/admin/delete/5'), false);
  assert.equal(isValidId('5; rm -rf'), false);
  assert.equal(isValidId(''), false);
});

test('buildTokenCookie hardens the JWT cookie for https (H3)', () => {
  const c = buildTokenCookie('jwt-value', 'https://adapt.example.org');
  assert.equal(c.name, 'token');
  assert.equal(c.value, 'jwt-value');
  assert.equal(c.domain, 'adapt.example.org');
  assert.equal(c.path, '/');
  assert.equal(c.httpOnly, true);
  assert.equal(c.secure, true);
  assert.equal(c.sameSite, 'Strict');
});

test('buildTokenCookie relaxes secure for localhost http dev but keeps httpOnly', () => {
  const c = buildTokenCookie('jwt', 'http://adapt.libretexts.localhost');
  assert.equal(c.secure, false);
  assert.equal(c.httpOnly, true);
});
