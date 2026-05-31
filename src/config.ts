/**
 * Environment-driven configuration. Nothing is hardcoded — DevOps supplies
 * everything via env (see .env.example). Validated once at startup.
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
   *  'in-process' = scan with the bundled @libretexts/remedy-core. */
  scanMode: ScanMode;
  /** remedy-server endpoint for scanMode=http, e.g. http://remedy:8000/v1/validate/html */
  remedyEndpoint?: string;
  /** Optional bearer token for the remedy endpoint. */
  remedyToken?: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadConfig(): Config {
  const scanMode = (process.env.SCAN_MODE ?? 'http') as ScanMode;
  const cfg: Config = {
    adaptBaseUrl: req('ADAPT_BASE_URL').replace(/\/$/, ''),
    adaptToken: process.env.ADAPT_TOKEN || undefined,
    adaptEmail: process.env.ADAPT_EMAIL || undefined,
    adaptPassword: process.env.ADAPT_PASSWORD || undefined,
    renderMode: (process.env.RENDER_MODE ?? 'iframe') as RenderMode,
    mathjaxTimeoutMs: Number(process.env.MATHJAX_TIMEOUT_MS ?? 20000),
    navTimeoutMs: Number(process.env.NAV_TIMEOUT_MS ?? 30000),
    scanMode,
    remedyEndpoint: process.env.REMEDY_ENDPOINT || undefined,
    remedyToken: process.env.REMEDY_TOKEN || undefined,
  };

  if (!cfg.adaptToken && !(cfg.adaptEmail && cfg.adaptPassword)) {
    throw new Error('Provide ADAPT_TOKEN (preferred) or ADAPT_EMAIL + ADAPT_PASSWORD.');
  }
  if (cfg.scanMode === 'http' && !cfg.remedyEndpoint) {
    throw new Error('SCAN_MODE=http requires REMEDY_ENDPOINT.');
  }
  if (!['http', 'in-process'].includes(cfg.scanMode)) {
    throw new Error(`Invalid SCAN_MODE: ${cfg.scanMode}`);
  }
  return cfg;
}
