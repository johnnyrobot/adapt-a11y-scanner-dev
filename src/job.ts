import { loadConfig } from './config.js';
import { AdaptRenderer } from './renderer.js';
import { scanHtml } from './scanner.js';
import { listAssignmentQuestions } from './adapt-client.js';
import { summarize, type RunSummary } from './report.js';
import { JobLifetime } from './lifecycle.js';
import type { QuestionScanResult } from './types.js';

export interface AdaptScanRequest {
  mode: 'question' | 'assignment';
  id: number | string;
  assignmentId?: number | string;
}

export interface AdaptScanReport extends RunSummary {
  scanMode: ReturnType<typeof loadConfig>['scanMode'];
  renderMode: ReturnType<typeof loadConfig>['renderMode'];
  results: QuestionScanResult[];
}

async function scanOne(
  renderer: AdaptRenderer,
  cfg: ReturnType<typeof loadConfig>,
  questionId: number | string,
  assignmentId?: number | string,
  lifetime?: JobLifetime,
): Promise<QuestionScanResult> {
  const base = {
    questionId,
    assignmentId,
    renderedUrl: '',
    capturedBytes: 0,
    scannedAt: new Date().toISOString(),
    findings: [],
    overallPassed: false,
    failed: false,
    stats: { errors: 0, warnings: 0, total: 0 },
  } satisfies QuestionScanResult;
  try {
    lifetime?.check();
    const { url, html } = await renderer.renderQuestion(questionId, assignmentId);
    const { findings, overallPassed } = await scanHtml(html, cfg, lifetime);
    const errors = findings.filter((f) => f.severity === 'error').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    return {
      ...base,
      renderedUrl: url,
      capturedBytes: Buffer.byteLength(html, 'utf8'),
      findings,
      overallPassed,
      stats: { errors, warnings, total: findings.length },
    };
  } catch (e) {
    lifetime?.check();
    return { ...base, error: (e as Error).message, failed: true };
  }
}

export async function runAdaptScan(req: AdaptScanRequest, admittedLifetime?: JobLifetime): Promise<AdaptScanReport> {
  const cfg = loadConfig();
  if (req.mode === 'question' && cfg.renderMode === 'spa' && req.assignmentId == null) {
    throw new Error('RENDER_MODE=spa needs assignmentId for question scans.');
  }

  const lifetime = admittedLifetime ?? new JobLifetime(cfg.jobTimeoutMs);
  const renderer = new AdaptRenderer(cfg, lifetime);

  const results: QuestionScanResult[] = [];
  try {
    lifetime.check();
    await renderer.init();
    if (req.mode === 'question') {
      results.push(await scanOne(renderer, cfg, req.id, req.assignmentId, lifetime));
    } else {
      const questions = await listAssignmentQuestions(
        cfg.adaptBaseUrl, renderer.getToken(), req.id, lifetime.timeout(cfg.navTimeoutMs), lifetime.signal);
      for (const q of questions) {
        results.push(await scanOne(renderer, cfg, q.id, req.id, lifetime));
      }
    }
  } catch (error) {
    lifetime.check();
    throw error;
  } finally {
    try { await renderer.close(); } finally { if (!admittedLifetime) lifetime.dispose(); }
  }

  lifetime.check();
  return { scanMode: cfg.scanMode, renderMode: cfg.renderMode, ...summarize(results), results };
}
