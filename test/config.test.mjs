/**
 * Tests for env validation (buildConfig is the pure core of loadConfig). Covers
 * MF-3 (http requires REMEDY_API_KEY), M2 (timeout env must be finite/positive),
 * M5 (RENDER_MODE validated), L5 (ADAPT_BASE_URL must be a valid URL), and the
 * H3 https-enforcement. Pure function — no dotenv, no process.env, no .env read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../dist/config.js';

const base = {
  ADAPT_BASE_URL: 'https://adapt.example.org',
  ADAPT_TOKEN: 'tok',
  SCAN_MODE: 'http',
  REMEDY_ENDPOINT: 'https://remedy.example.org/v1/validate/html',
  REMEDY_API_KEY: 'key',
};

test('builds a valid http config', () => {
  const cfg = buildConfig(base);
  assert.equal(cfg.scanMode, 'http');
  assert.equal(cfg.remedyApiKey, 'key');
  assert.equal(cfg.renderMode, 'iframe');
  assert.equal(cfg.adaptBaseUrl, 'https://adapt.example.org');
});

test('strips a trailing slash from ADAPT_BASE_URL', () => {
  assert.equal(buildConfig({ ...base, ADAPT_BASE_URL: 'https://adapt.example.org/' }).adaptBaseUrl, 'https://adapt.example.org');
});

test('requires ADAPT_TOKEN or ADAPT_EMAIL+ADAPT_PASSWORD', () => {
  assert.throws(() => buildConfig({ ...base, ADAPT_TOKEN: undefined }), /ADAPT_TOKEN/);
  const cfg = buildConfig({ ...base, ADAPT_TOKEN: undefined, ADAPT_EMAIL: 'a@b.c', ADAPT_PASSWORD: 'p' });
  assert.equal(cfg.adaptEmail, 'a@b.c');
});

test('http mode requires REMEDY_ENDPOINT', () => {
  assert.throws(() => buildConfig({ ...base, REMEDY_ENDPOINT: undefined }), /REMEDY_ENDPOINT/);
});

test('http mode requires REMEDY_API_KEY (MF-3)', () => {
  assert.throws(() => buildConfig({ ...base, REMEDY_API_KEY: undefined }), /REMEDY_API_KEY/);
});

test('in-process mode requires neither endpoint nor api key', () => {
  const cfg = buildConfig({ ADAPT_BASE_URL: 'https://a.org', ADAPT_TOKEN: 't', SCAN_MODE: 'in-process' });
  assert.equal(cfg.scanMode, 'in-process');
});

test('rejects an invalid SCAN_MODE', () => {
  assert.throws(() => buildConfig({ ...base, SCAN_MODE: 'bogus' }), /SCAN_MODE/);
});

test('rejects an invalid RENDER_MODE and honors a valid one (M5)', () => {
  assert.throws(() => buildConfig({ ...base, RENDER_MODE: 'SPA' }), /RENDER_MODE/);
  assert.equal(buildConfig({ ...base, RENDER_MODE: 'spa' }).renderMode, 'spa');
});

test('rejects empty / non-numeric / non-positive timeout env vars (M2)', () => {
  assert.throws(() => buildConfig({ ...base, MATHJAX_TIMEOUT_MS: '' }), /MATHJAX_TIMEOUT_MS/);
  assert.throws(() => buildConfig({ ...base, NAV_TIMEOUT_MS: 'abc' }), /NAV_TIMEOUT_MS/);
  assert.throws(() => buildConfig({ ...base, REMEDY_TIMEOUT_MS: '0' }), /REMEDY_TIMEOUT_MS/);
  assert.throws(() => buildConfig({ ...base, MATHJAX_TIMEOUT_MS: '-5' }), /MATHJAX_TIMEOUT_MS/);
  assert.equal(buildConfig({ ...base, MATHJAX_TIMEOUT_MS: '5000' }).mathjaxTimeoutMs, 5000);
});

test('rejects an ADAPT_BASE_URL that is not a valid URL (L5)', () => {
  assert.throws(() => buildConfig({ ...base, ADAPT_BASE_URL: 'not a url' }), /ADAPT_BASE_URL/);
});

test('chromiumNoSandbox defaults off and parses truthy values (M6)', () => {
  assert.equal(buildConfig(base).chromiumNoSandbox, false);
  assert.equal(buildConfig({ ...base, CHROMIUM_NO_SANDBOX: '1' }).chromiumNoSandbox, true);
  assert.equal(buildConfig({ ...base, CHROMIUM_NO_SANDBOX: 'true' }).chromiumNoSandbox, true);
});

test('enforces https on ADAPT_BASE_URL except for localhost dev (H3)', () => {
  assert.throws(() => buildConfig({ ...base, ADAPT_BASE_URL: 'http://adapt.example.org' }), /https/);
  assert.equal(buildConfig({ ...base, ADAPT_BASE_URL: 'http://adapt.libretexts.localhost' }).adaptBaseUrl, 'http://adapt.libretexts.localhost');
});
