/**
 * Scan rendered HTML for accessibility findings, in one of two modes:
 *
 *   - http:       POSTs the HTML to a running remedy-server (e.g. /v1/validate/html).
 *     Decoupled; scales independently. This is the production mode.
 *   - in-process: uses the bundled @libretexts/remedy-core (math-aware rules,
 *     understands rendered MathJax). Dev-only — requires the package to be
 *     installed/linked (see README); not wired for production transfer.
 *
 * Both return a ScanResult: the normalized findings plus the server's
 * authoritative pass/fail verdict, so the caller's CI gate can fail closed.
 */
import type { Config } from './config.js';
import type { Finding } from './types.js';

export interface ScanResult {
  findings: Finding[];
  /** The validator's authoritative verdict. Fail-closed: unknown ⇒ false. */
  overallPassed: boolean;
}

export async function scanHtml(html: string, cfg: Config): Promise<ScanResult> {
  return cfg.scanMode === 'in-process' ? scanInProcess(html) : scanHttp(html, cfg);
}

async function scanInProcess(html: string): Promise<ScanResult> {
  let core: { scanHtmlFull: (h: string) => Promise<Finding[]> };
  try {
    // Dev-only optional dependency. The specifier is built at runtime so `tsc`
    // doesn't require the package to be present.
    const pkg = ['@libretexts', 'remedy-core'].join('/');
    core = (await import(pkg)) as typeof core;
  } catch {
    throw new Error(
      'SCAN_MODE=in-process requires @libretexts/remedy-core to be installed/linked. ' +
        'Install it, or use SCAN_MODE=http with a running remedy-server.',
    );
  }
  const findings = normalizeCore(await core.scanHtmlFull(html));
  return { findings, overallPassed: !findings.some((f) => f.severity === 'error') };
}

const MAX_HTTP_ATTEMPTS = 4;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function scanHttp(html: string, cfg: Config): Promise<ScanResult> {
  for (let attempt = 0; ; attempt++) {
    // Rebuild the body each attempt — a FormData/Blob stream can only be sent once.
    const form = new FormData();
    form.append('file', new Blob([html], { type: 'text/html' }), 'question.html');

    let res: Response;
    try {
      res = await fetch(cfg.remedyEndpoint!, {
        method: 'POST',
        headers: buildRemedyHeaders(cfg),
        body: form,
        // MF-5: the /v1/validate/html scan is synchronous and heavy; bound it so
        // a stalled server can't hang the whole assignment batch.
        signal: AbortSignal.timeout(cfg.remedyTimeoutMs),
      });
    } catch (e) {
      if ((e as Error).name === 'TimeoutError') {
        throw new Error(`remedy-server timed out after ${cfg.remedyTimeoutMs}ms`);
      }
      throw e;
    }

    // MF-6: honor the server's rate limit with bounded backoff before giving up.
    if (res.status === 429 && attempt < MAX_HTTP_ATTEMPTS - 1) {
      const wait = backoffMs(attempt, parseRetryAfterMs(res.headers.get('retry-after')));
      await res.text().catch(() => undefined);
      await sleep(wait);
      continue;
    }

    if (!res.ok) {
      const rid = res.headers.get('x-request-id');
      throw new Error(
        `remedy-server ${res.status}${rid ? ` [request_id=${rid}]` : ''}: ${(await res.text()).slice(0, 300)}`,
      );
    }
    return parseRemedyResponse(parseJsonStrict(await res.text(), 'remedy-server'));
  }
}

/** Parse a `Retry-After` header (delta-seconds form) to ms; null/garbage ⇒ undefined. */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (header == null) return undefined;
  const secs = Number(header);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined;
}

/** Backoff for a 429: honor the server's Retry-After (capped), else capped exponential. */
export function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs != null) return Math.min(retryAfterMs, 60000);
  return Math.min(1000 * 2 ** attempt, 30000);
}

/** Parse JSON, turning a non-JSON (e.g. 2xx HTML error page) body into a clear
 *  error instead of a cryptic SyntaxError that aborts the batch (L1). */
export function parseJsonStrict(text: string, ctx: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${ctx} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/** Auth/transport headers for the remedy-server. The server guards
 *  /v1/validate/html with an `X-API-Key` header (it ignores Authorization). */
export function buildRemedyHeaders(cfg: Pick<Config, 'remedyApiKey'>): Record<string, string> {
  const headers: Record<string, string> = {};
  if (cfg.remedyApiKey) headers['X-API-Key'] = cfg.remedyApiKey;
  return headers;
}

/**
 * Parse the remedy-server /v1/validate/html response. The server emits findings
 * under `all_violations` (a merged, deduped, severity-sorted list) and its
 * verdict under `overall_passed`. There is no `findings`/`results`/`issues` key.
 * A missing/unrecognized shape is treated as fail-closed (overallPassed=false).
 */
export function parseRemedyResponse(body: unknown): ScanResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(b.all_violations) ? b.all_violations : [];
  return { findings: normalize(raw), overallPassed: b.overall_passed === true };
}

/** Map an axe/pa11y/lighthouse `impact` — or an already-canonical severity — to
 *  the value the CI gate keys on: critical|serious|error ⇒ error, everything
 *  else ⇒ warning.
 *
 *  Input is trimmed and lower-cased because it reaches us from several tools
 *  (and, via normalizeCore, from remedy-core) with inconsistent casing and
 *  padding; an exact comparison silently downgraded "Critical" / " SERIOUS "
 *  to a non-blocking warning. `error` is accepted so already-canonical
 *  severities survive the round trip instead of being downgraded. */
export function mapImpact(impact: unknown): 'error' | 'warning' {
  const value = String(impact ?? '').trim().toLowerCase();
  return value === 'critical' || value === 'serious' || value === 'error'
    ? 'error'
    : 'warning';
}

/** Normalize remedy-server `all_violations` items to Finding[]. Field map (per
 *  validator.py): id, impact, tool, description, wcag (string), context (pa11y)
 *  / html_snippets[] (axe), selector (pa11y). Fixability is not emitted on the
 *  validate-only endpoint, so `fixable` is always undefined. */
export function normalize(items: unknown[]): Finding[] {
  return items.map((f) => {
    const o = f as Record<string, unknown>;
    const snippet =
      o.context != null
        ? String(o.context)
        : Array.isArray(o.html_snippets) && o.html_snippets.length
          ? String(o.html_snippets[0])
          : undefined;
    return {
      ruleId: String(o.id ?? 'unknown'),
      wcag: o.wcag ? String(o.wcag) : undefined,
      severity: mapImpact(o.impact),
      message: String(o.description ?? o.help ?? ''),
      selector: o.selector ? String(o.selector) : undefined,
      snippet,
      fixable: undefined,
      source: o.tool ? String(o.tool) : undefined,
    };
  });
}

/** Normalize @libretexts/remedy-core (in-process) findings, whose shape differs
 *  from the HTTP server's: it already carries ruleId/severity/message. */
export function normalizeCore(items: unknown[]): Finding[] {
  return items.map((f) => {
    const o = f as Record<string, unknown>;
    return {
      ruleId: String(o.ruleId ?? o.rule ?? o.code ?? 'unknown'),
      wcag: o.wcag ? String(o.wcag) : undefined,
      // Canonicalize like the HTTP path does. Passing the raw string through
      // meant an in-process scan reporting "critical"/"serious" never matched
      // the `severity === 'error'` gate, so a critical finding still exited 0.
      severity: mapImpact(o.severity ?? o.type ?? o.impact),
      message: String(o.message ?? o.description ?? ''),
      selector: o.selector ? String(o.selector) : undefined,
      snippet: o.snippet ? String(o.snippet) : undefined,
      fixable: typeof o.fixable === 'boolean' ? o.fixable : undefined,
      source: o.source ? String(o.source) : undefined,
    };
  });
}
