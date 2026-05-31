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

export class AdaptRenderer {
  private browser?: Browser;
  private ctx?: BrowserContext;
  private token?: string;
  private readonly host: string;

  constructor(private readonly cfg: Config) {
    this.host = new URL(cfg.adaptBaseUrl).hostname;
  }

  async init(): Promise<void> {
    this.browser = await chromium.launch({ args: ['--no-sandbox'] });
    this.ctx = await this.browser.newContext();
    this.token = await this.resolveToken();
    await this.ctx.addCookies([
      { name: 'token', value: this.token, domain: this.host, path: '/' },
    ]);
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
    try {
      // In-page fetch so the request uses the browser's resolver (handles both
      // real domains and *.localhost dev hosts).
      await page.goto(`${this.cfg.adaptBaseUrl}/login`, { waitUntil: 'domcontentloaded' });
      const token = await page.evaluate(
        async ({ base, email, password }) => {
          const r = await fetch(`${base}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
          if (!r.ok) throw new Error(`login ${r.status}: ${await r.text()}`);
          return (await r.json()).token as string;
        },
        { base: this.cfg.adaptBaseUrl, email: this.cfg.adaptEmail, password: this.cfg.adaptPassword },
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
    for (let i = 0; i < 30; i++) {
      const frame = page.frames().find((f) => f.url().includes('get-header-html'));
      if (frame) {
        const ready = await frame.evaluate(() => document.readyState === 'complete').catch(() => false);
        if (ready) return frame;
      }
      await page.waitForTimeout(1000);
    }
    throw new Error('question content frame (get-header-html) did not appear');
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
    await this.ctx?.close();
    await this.browser?.close();
  }
}
