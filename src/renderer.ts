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
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
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
    this.browser = await chromium.launch({ args });
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
    try {
      let target: Frame | Page;
      let url: string;

      if (this.cfg.renderMode === 'spa') {
        if (assignmentId == null) throw new Error('SPA render mode needs an assignmentId');
        url = `${this.cfg.adaptBaseUrl}/assignments/${assignmentId}/questions/view/${questionId}`;
        await page.goto(url, { waitUntil: 'networkidle' });
        target = await this.waitForContentFrame(page);
      } else {
        // iframe mode: the question's content document, served standalone.
        url = `${this.cfg.adaptBaseUrl}/api/get-header-html/${questionId}`;
        await page.goto(url, { waitUntil: 'networkidle' });
        target = page;
      }

      await this.waitForMathJax(target);
      const html = await target.content();
      return { url, html };
    } finally {
      await page.close();
    }
  }

  /** In SPA mode, find the frame that actually holds the question content. */
  private async waitForContentFrame(page: Page): Promise<Frame> {
    // Deadline-driven rather than a fixed 30 iterations: a hard-coded 30s both
    // overran a tight NAV_TIMEOUT_MS (a 10s CI gate still waited 30s) and cut
    // short a deliberately generous one.
    const pollMs = 1000;
    const deadline = Date.now() + this.cfg.navTimeoutMs;
    for (;;) {
      const frame = page.frames().find((f) => f.url().includes('get-header-html'));
      if (frame) {
        const ready = await frame.evaluate(() => document.readyState === 'complete').catch(() => false);
        if (ready) return frame;
      }
      if (Date.now() + pollMs > deadline) break;
      await page.waitForTimeout(pollMs);
    }
    throw new Error(
      `question content frame (get-header-html) did not appear within ${this.cfg.navTimeoutMs}ms`,
    );
  }

  /** Wait for MathJax v2 to finish typesetting (or time out and capture anyway). */
  private async waitForMathJax(target: Frame | Page): Promise<void> {
    await target
      .waitForFunction(
        () => {
          const mj = (window as unknown as { MathJax?: { Hub?: { queue?: { running?: number; pending?: number } } } }).MathJax;
          const typeset = !!document.querySelector(
            '.MathJax, .MathJax_Display, .mjx-chtml, [id^="MathJax-Element"]',
          );
          if (!mj?.Hub?.queue) return typeset || document.readyState === 'complete';
          const q = mj.Hub.queue;
          return !q.running && !q.pending && (typeset || true);
        },
        undefined,
        { timeout: this.cfg.mathjaxTimeoutMs },
      )
      .catch(() => {
        /* timed out — capture whatever rendered */
      });
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
