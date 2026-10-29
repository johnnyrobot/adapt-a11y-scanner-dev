/**
 * Environment-driven configuration. Nothing is hardcoded — DevOps supplies
 * everything via env (see .env.example). `buildConfig` is the pure, fully
 * validated core (no I/O); `loadConfig` applies it to `process.env` after
 * dotenv has populated it. Validation is total: every consumed env var is
 * checked here at startup, so the rest of the app can trust the Config.
 */
import 'dotenv/config';

export type ScanMode = 'http' | 'in-process';
export type RenderMode = 'iframe' | 'spa';

export interface Config {
  /** Base URL of the ADAPT instance, e.g. https://adapt.libretexts.org */
  adaptBaseUrl: string;
  /** Pre-issued JWT for a service account (preferred in production). */
  adaptToken?: string;
  /** Fallback credentials if no token is supplied (dev / bootstrap only). */
  adaptEmail?: string;
  adaptPassword?: string;

  /** 'iframe' = render /api/get-header-html/{id} directly (fast, deterministic).
   *  'spa'    = render the full SPA question-view (closer to the student view). */
  renderMode: RenderMode;
  /** ms to wait for MathJax (v2) typesetting before capture. */
  mathjaxTimeoutMs: number;
  /** ms for navigation/network idle. */
  navTimeoutMs: number;

  /** 'http'       = POST the rendered DOM to a running remedy-server.
   *  'in-process' = scan with the bundled @libretexts/remedy-core (dev-only). */
  scanMode: ScanMode;
  /** remedy-server endpoint for scanMode=http, e.g. http://remedy:8000/v1/validate/html */
  remedyEndpoint?: string;
  /** API key for the remedy endpoint, sent as the `X-API-Key` header. Required
   *  in production (the server forces a key); the server ignores Authorization. */
  remedyApiKey?: string;
  /** ms to wait for the synchronous remedy-server scan before aborting. */
  remedyTimeoutMs: number;

  /** Launch Chromium with --no-sandbox. Off by default; the sandbox should stay
   *  on (run the container as the non-root pwuser). Set only when running as
   *  root where the sandbox is impossible. */
  chromiumNoSandbox: boolean;
  maxActiveJobs: number;
  maxQueuedJobs: number;
  jobTimeoutMs: number;
}

/** A minimal view of the environment, so buildConfig is pure and testable. */
export type Env = Record<string, string | undefined>;

function req(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/** Parse a positive, finite integer env var; unset ⇒ default; empty/garbage/≤0 ⇒ throw. */
function positiveMs(env: Env, name: string, def: number): number {
  const raw = env[name];
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number of milliseconds (got ${JSON.stringify(raw)}).`);
  }
  return n;
}

function boundedInteger(env: Env, name: string, def: number): number {
  const n = Number(env[name] ?? def);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2_147_483_647) {
    throw new Error(`${name} must be a positive integer no greater than 2147483647.`);
  }
  return n;
}

/** Build a validated Config from an explicit environment map. Pure (no I/O). */
export function buildConfig(env: Env): Config {
  // --- ADAPT base URL: valid URL + https (localhost may use http for dev) ---
  const rawBase = req(env, 'ADAPT_BASE_URL').replace(/\/$/, '');
  let base: URL;
  try {
    base = new URL(rawBase);
  } catch {
    throw new Error(`ADAPT_BASE_URL is not a valid URL: ${JSON.stringify(rawBase)}`);
  }
  const isLocal =
    base.hostname === 'localhost' || base.hostname === '127.0.0.1' || base.hostname.endsWith('.localhost');
  if (base.protocol !== 'https:' && !isLocal) {
    throw new Error(
      `ADAPT_BASE_URL must use https (got ${base.protocol}); only localhost/127.0.0.1 may use http for dev.`,
    );
  }

  // --- render mode ---
  const renderMode = (env.RENDER_MODE ?? 'iframe') as RenderMode;
  if (!['iframe', 'spa'].includes(renderMode)) {
    throw new Error(`Invalid RENDER_MODE: ${JSON.stringify(renderMode)} (expected 'iframe' or 'spa').`);
  }

  // --- scan mode ---
  const scanMode = (env.SCAN_MODE ?? 'http') as ScanMode;
  if (!['http', 'in-process'].includes(scanMode)) {
    throw new Error(`Invalid SCAN_MODE: ${JSON.stringify(scanMode)} (expected 'http' or 'in-process').`);
  }

  const cfg: Config = {
    adaptBaseUrl: rawBase,
    maxActiveJobs: boundedInteger(env, 'SCANNER_MAX_ACTIVE_JOBS', 1),
    maxQueuedJobs: boundedInteger(env, 'SCANNER_MAX_QUEUED_JOBS', 8),
    jobTimeoutMs: boundedInteger(env, 'SCANNER_JOB_TIMEOUT_MS', 900000),
    adaptToken: env.ADAPT_TOKEN || undefined,
    adaptEmail: env.ADAPT_EMAIL || undefined,
    adaptPassword: env.ADAPT_PASSWORD || undefined,
    renderMode,
    mathjaxTimeoutMs: positiveMs(env, 'MATHJAX_TIMEOUT_MS', 20000),
    navTimeoutMs: positiveMs(env, 'NAV_TIMEOUT_MS', 30000),
    scanMode,
    remedyEndpoint: env.REMEDY_ENDPOINT || undefined,
    remedyApiKey: env.REMEDY_API_KEY || undefined,
    remedyTimeoutMs: positiveMs(env, 'REMEDY_TIMEOUT_MS', 240000),
    chromiumNoSandbox: env.CHROMIUM_NO_SANDBOX === '1' || env.CHROMIUM_NO_SANDBOX === 'true',
  };

  // --- auth: token preferred, else email+password (dev/bootstrap only) ---
  if (!cfg.adaptToken && !(cfg.adaptEmail && cfg.adaptPassword)) {
    throw new Error('Provide ADAPT_TOKEN (preferred) or ADAPT_EMAIL + ADAPT_PASSWORD.');
  }

  // --- http mode requires a reachable, authenticated remedy endpoint ---
  if (cfg.scanMode === 'http') {
    if (!cfg.remedyEndpoint) throw new Error('SCAN_MODE=http requires REMEDY_ENDPOINT.');
    if (!cfg.remedyApiKey) {
      throw new Error('SCAN_MODE=http requires REMEDY_API_KEY (the remedy-server X-API-Key; production forces one).');
    }
  }

  return cfg;
}

export function loadConfig(): Config {
  return buildConfig(process.env);
}
