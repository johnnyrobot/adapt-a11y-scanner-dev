/**
 * Headless renderer for ADAPT questions.
 *
 * ADAPT renders questions client-side (Vue SPA + MathJax v2), so a real browser
 * is required. We authenticate by setting ADAPT's `token` cookie (a JWT), then
 * either render the question's content iframe directly (`/api/get-header-html/{id}`,
 * fast + deterministic) or the full SPA question-view, and capture the DOM only
 * after MathJax has finished typesetting.
 *
 * One browser is reused across many questions for batch efficiency.
 */
import { chromium, type Browser, type BrowserContext, type Frame, type Page, type Response } from 'playwright';
import type { Config } from './config.js';

export interface RenderedQuestion {
  url: string;
  html: string;
}

/** ADAPT question/assignment ids are numeric. Reject anything else so a crafted
 *  id can't forge an authenticated same-origin request via path traversal (L4). */
export function isValidId(id: number | string): boolean {
  return /^[0-9]+$/.test(String(id));
}

/** Build the service-account JWT cookie, hardened so rendered (instructor-authored)
 *  question JS cannot read or exfiltrate it: httpOnly + SameSite=Strict, and
 *  secure whenever the base URL is https (relaxed only for localhost dev). H3. */
export function buildTokenCookie(
  token: string,
  baseUrl: string,
): { name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean; sameSite: 'Strict' } {
  const u = new URL(baseUrl);
  return {
    name: 'token',
    value: token,
    domain: u.hostname,
    path: '/',
    httpOnly: true,
    secure: u.protocol === 'https:',
    sameSite: 'Strict',
  };
}

export class AdaptRenderer {
  private browser?: Browser;
  private ctx?: BrowserContext;
  private token?: string;

  constructor(private readonly cfg: Config) {}

  async init(): Promise<void> {
    // Keep the Chromium sandbox ON by default (run as non-root pwuser in the
    // container). Only disable it via CHROMIUM_NO_SANDBOX when running as root (M6).
    const args = this.cfg.chromiumNoSandbox ? ['--no-sandbox'] : [];
    this.browser = await chromium.launch({ chromiumSandbox: !this.cfg.chromiumNoSandbox, args });
    try {
      this.ctx = await this.browser.newContext();
      this.token = await this.resolveToken();
      await this.ctx.addCookies([buildTokenCookie(this.token, this.cfg.adaptBaseUrl)]);
    } catch (e) {
      // L2: don't leak the browser if a later init step (e.g. login) throws.
      await this.close();
      throw e;
    }
  }

  /** The resolved service-account JWT (set after init) — reused for ADAPT API calls. */
  getToken(): string {
    if (!this.token) throw new Error('renderer not initialized — call init()');
    return this.token;
  }

  /** Service-account JWT: use the supplied token, else log in for one. */
  private async resolveToken(): Promise<string> {
    if (this.cfg.adaptToken) return this.cfg.adaptToken;
    const page = await this.ctx!.newPage();
    page.setDefaultTimeout(this.cfg.navTimeoutMs);
    try {
      // In-page fetch so the request uses the browser's resolver (handles both
      // real domains and *.localhost dev hosts).
      await page.goto(`${this.cfg.adaptBaseUrl}/login`, { waitUntil: 'domcontentloaded' });
      const token = await page.evaluate(
        async ({ base, email, password, timeout }) => {
          // Bound the login so a stalled instance can't hang init() forever (M1).
          const r = await fetch(`${base}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
            signal: AbortSignal.timeout(timeout),
          });
          if (!r.ok) throw new Error(`login ${r.status}: ${await r.text()}`);
          return (await r.json()).token as string;
        },
        {
          base: this.cfg.adaptBaseUrl,
          email: this.cfg.adaptEmail,
          password: this.cfg.adaptPassword,
          timeout: this.cfg.navTimeoutMs,
        },
      );
      if (!token) throw new Error('ADAPT login returned no token');
      return token;
    } finally {
      await page.close();
    }
  }

  /** Render one question and return its post-MathJax DOM. */
  async renderQuestion(questionId: number | string, assignmentId?: number | string): Promise<RenderedQuestion> {
    if (!this.ctx) throw new Error('renderer not initialized — call init()');
    if (!isValidId(questionId)) {
      throw new Error(`Invalid questionId (must be numeric): ${JSON.stringify(questionId)}`);
    }
    if (assignmentId != null && !isValidId(assignmentId)) {
      throw new Error(`Invalid assignmentId (must be numeric): ${JSON.stringify(assignmentId)}`);
    }
    const page = await this.ctx.newPage();
    page.setDefaultTimeout(this.cfg.navTimeoutMs);
    // Record document responses before navigation, including SPA child frames.
    const documents = new Map<Frame, Response>();
    page.on('response', response => {
      if (response.request().isNavigationRequest()) documents.set(response.frame(), response);
    });
    try {
      let target: Frame | Page;
      let url: string;

      if (this.cfg.renderMode === 'spa') {
        if (assignmentId == null) throw new Error('SPA render mode needs an assignmentId');
        url = `${this.cfg.adaptBaseUrl}/assignments/${assignmentId}/questions/view/${questionId}`;
        const response = await page.goto(url, { waitUntil: 'networkidle' });
        this.assertDocument(response, page.url(), url, 'outer navigation');
        target = await this.waitForContentFrame(page, questionId);
        this.assertDocument(documents.get(target), target.url(), `${this.cfg.adaptBaseUrl}/api/get-header-html/${questionId}`, 'content frame');
      } else {
        // iframe mode: the question's content document, served standalone.
        url = `${this.cfg.adaptBaseUrl}/api/get-header-html/${questionId}`;
        const response = await page.goto(url, { waitUntil: 'networkidle' });
        this.assertDocument(response, page.url(), url, 'question navigation');
        target = page;
      }

      await this.waitForMathJax(target);
      // Re-check identities after readiness: scripts may navigate while typesetting.
      this.assertDocument(documents.get(page.mainFrame()), page.url(), url, 'outer capture');
      const frame = target === page ? page.mainFrame() : target as Frame;
      this.assertDocument(documents.get(frame), target.url(), this.cfg.renderMode === 'spa'
        ? `${this.cfg.adaptBaseUrl}/api/get-header-html/${questionId}` : url, 'content capture');
      if (await target.locator('input[type="password"]').count()) {
        throw new Error('capture authentication document: password input at question route');
      }
      const html = await target.content();
      return { url, html };
    } catch (error) {
      const message = (error as Error).message;
      if (message.startsWith('capture ') || message.startsWith('readiness ')) throw error;
      throw new Error('capture navigation failed, timed out or interrupted');
    } finally {
      await page.close();
    }
  }

  /** In SPA mode, find the frame that actually holds the question content. */
  private async waitForContentFrame(page: Page, questionId: number | string): Promise<Frame> {
    // Deadline-driven rather than a fixed 30 iterations: a hard-coded 30s both
    // overran a tight NAV_TIMEOUT_MS (a 10s CI gate still waited 30s) and cut
    // short a deliberately generous one.
    const pollMs = 1000;
    const deadline = Date.now() + this.cfg.navTimeoutMs;
    for (;;) {
      const expected = new URL(`${this.cfg.adaptBaseUrl}/api/get-header-html/${questionId}`);
      const candidates = page.frames().filter(f => f !== page.mainFrame());
      let frame = candidates.find(f => f.url() === expected.href);
      if (!frame) {
        for (const candidate of candidates) {
          const element = await candidate.frameElement();
          const source = await element.getAttribute('src');
          await element.dispose();
          if (source && new URL(source, page.url()).href === expected.href && candidate.url() !== 'about:blank') {
            frame = candidate;
            break;
          }
        }
      }
      if (frame) {
        const ready = await frame.evaluate(() => document.readyState === 'complete').catch(() => false);
        if (ready) {
          await frame.waitForLoadState('networkidle', { timeout: Math.max(1, deadline - Date.now()) });
          return frame;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // Sleep only what is left rather than breaking when under one interval
      // remains: a 2000ms timeout would otherwise give up after ~1000ms.
      await page.waitForTimeout(Math.min(pollMs, remaining));
    }
    throw new Error(
      `capture content frame: expected question route did not appear within ${this.cfg.navTimeoutMs}ms`,
    );
  }

  /** Only the exact source-backed question routes are accepted. Diagnostics omit
   * URL credentials, query, fragment and unknown paths (which may contain secrets). */
  private assertDocument(response: Response | null | undefined, actual: string, expected: string, stage: string): void {
    const location = new URL(actual);
    const safePath = /^\/(api\/get-header-html\/[0-9]+|assignments\/[0-9]+\/questions\/view\/[0-9]+|login)\/?$/.test(location.pathname)
      ? location.pathname : '/[unexpected-path]';
    const diagnostic = `${stage} status=${response?.status() ?? 'missing'} location=${location.origin}${safePath}`;
    if (actual !== new URL(expected).href || !response?.ok()) {
      throw new Error(`capture rejected: ${diagnostic}`);
    }
    if (!/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.headers()['content-type'] ?? '')) {
      throw new Error(`capture non-HTML document: ${diagnostic}`);
    }
  }

  /** The v2 startup signal replays history. Queue a fresh Typeset after End,
   * then inspect actual output; an idle queue alone proves nothing. */
  private async waitForMathJax(target: Frame | Page): Promise<void> {
    const deadline = Date.now() + this.cfg.mathjaxTimeoutMs;
    try {
      const probe = await target.waitForFunction(() => {
        const mj = (window as unknown as { MathJax?: { version?: string; Hub?: unknown } }).MathJax;
        const declared = !!mj || !!document.querySelector('script[src*="MathJax" i], script[type="text/x-mathjax-config"]');
        const math = !!document.querySelector('math, script[type^="math/"], .MathJax, .MathJax_SVG');
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        let tex = false;
        while ((node = walker.nextNode())) {
          if (node.parentElement?.closest('script, style, pre, code, textarea')) continue;
          if (/\\\(|\\\[|\$\$/.test(node.textContent ?? '')) { tex = true; break; }
        }
        if (!declared && !math && !tex) return { required: false, known: false };
        if (mj?.version && !mj.version.startsWith('2.')) return { required: true, known: math || tex, unsupported: true };
        return mj?.Hub ? { required: true, known: math || tex, unsupported: false } : false;
      }, undefined, { timeout: this.cfg.mathjaxTimeoutMs });
      const state = await probe.jsonValue();
      await probe.dispose();
      if (!state || !state.required) return;
      if (state.unsupported) throw new Error('unsupported MathJax major');
      await target.evaluate(async ({ timeout, known }) => {
        interface Jax { inputID: string; }
        interface Hub {
          Register: { StartupHook: (name: string, fn: () => void) => void; MessageHook: (name: string, fn: () => void) => void };
          Queue: (...callbacks: unknown[]) => void;
          getAllJax: () => Jax[];
        }
        const mj = (window as unknown as { MathJax: { version: string; Hub: Hub } }).MathJax;
        if (!mj.version?.startsWith('2.')) throw new Error('unsupported MathJax major');
        const hub = mj.Hub;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('MathJax completion timeout')), timeout);
          const fail = () => { clearTimeout(timer); reject(new Error('MathJax typesetting failed')); };
          hub.Register.MessageHook('file load error', fail);
          hub.Register.MessageHook('Math Processing Error', fail);
          hub.Register.StartupHook('End', () => {
            hub.Queue(['Typeset', hub, document.body], () => {
              clearTimeout(timer);
              const jax = hub.getAllJax();
              const scripts = document.querySelectorAll('script[type^="math/"]');
              const incomplete = jax.some(j => {
                const output = document.getElementById(`${j.inputID}-Frame`);
                return !output || !output.querySelector('svg') && !output.matches('.MathJax, .MathJax_Display');
              });
              // Native MathML and source scripts must be consumed by a real jax.
              const raw = document.querySelector('body math:not(.MJX_Assistive_MathML math)');
              const errors = document.querySelector('.MathJax_Error, .merror, .mjx-merror, .MJXp-merror, .noError');
              if (incomplete || raw || errors || scripts.length !== jax.length || known && jax.length === 0) { fail(); return; }
              resolve();
            });
          });
        });
      }, { timeout: Math.max(1, deadline - Date.now()), known: state.known });
    } catch (error) {
      // Browser/library errors can quote private question source or request URLs.
      const unsupported = (error as Error).message.includes('unsupported MathJax major');
      throw new Error(`readiness failed: ${unsupported ? 'unsupported MathJax major' : 'MathJax startup/typesetting incomplete, failed or interrupted'}`);
    }
  }

  async close(): Promise<void> {
    // Each step guarded so a context-close failure still closes the browser (L2).
    try {
      await this.ctx?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.browser?.close();
    } catch {
      /* ignore */
    }
    this.ctx = undefined;
    this.browser = undefined;
  }
}
