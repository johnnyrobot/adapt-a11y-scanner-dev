/**
 * Scan rendered HTML for accessibility findings, in one of two modes:
 *
 *   - in-process: uses the bundled @libretexts/remedy-core (math-aware rules,
 *     understands rendered MathJax). Requires the package to be installed/linked.
 *   - http:       POSTs the HTML to a running remedy-server endpoint
 *     (e.g. /v1/validate/html). Decoupled; scales independently.
 *
 * Both normalize to Finding[] so callers don't care which engine ran.
 */
import type { Config } from './config.js';
import type { Finding } from './types.js';

export async function scanHtml(html: string, cfg: Config): Promise<Finding[]> {
  return cfg.scanMode === 'in-process' ? scanInProcess(html) : scanHttp(html, cfg);
}

async function scanInProcess(html: string): Promise<Finding[]> {
  let core: { scanHtmlFull: (h: string) => Promise<Finding[]> };
  try {
    // Optional dependency — only needed for in-process mode. The specifier is
    // built at runtime so `tsc` doesn't require the package to be present.
    const pkg = ['@libretexts', 'remedy-core'].join('/');
    core = (await import(pkg)) as typeof core;
  } catch {
    throw new Error(
      'SCAN_MODE=in-process requires @libretexts/remedy-core to be installed/linked. ' +
        'Install it, or use SCAN_MODE=http with a running remedy-server.',
    );
  }
  return normalize(await core.scanHtmlFull(html));
}

async function scanHttp(html: string, cfg: Config): Promise<Finding[]> {
  const form = new FormData();
  form.append('file', new Blob([html], { type: 'text/html' }), 'question.html');
  const headers: Record<string, string> = {};
  if (cfg.remedyToken) headers.Authorization = `Bearer ${cfg.remedyToken}`;

  const res = await fetch(cfg.remedyEndpoint!, { method: 'POST', headers, body: form });
  if (!res.ok) {
    throw new Error(`remedy-server ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = await res.json();
  // remedy-core-shaped responses expose `findings`; other validators (axe/pa11y/
  // lighthouse via /v1/validate/html) differ — extend this mapping to match the
  // endpoint you point at. See docs/INTEGRATION.md.
  const raw = body.findings ?? body.results ?? body.issues ?? [];
  return normalize(Array.isArray(raw) ? raw : []);
}

function normalize(items: unknown[]): Finding[] {
  return items.map((f) => {
    const o = f as Record<string, unknown>;
    return {
      ruleId: String(o.ruleId ?? o.rule ?? o.code ?? 'unknown'),
      wcag: o.wcag ? String(o.wcag) : undefined,
      severity: String(o.severity ?? o.type ?? o.impact ?? 'warning'),
      message: String(o.message ?? o.description ?? ''),
      selector: o.selector ? String(o.selector) : undefined,
      snippet: o.snippet ? String(o.snippet) : undefined,
      fixable: typeof o.fixable === 'boolean' ? o.fixable : undefined,
      source: o.source ? String(o.source) : undefined,
    };
  });
}
