#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { runAdaptScan, type AdaptScanRequest } from './job.js';

const HOST = process.env.SCANNER_HOST ?? '0.0.0.0';
const PORT = Number(process.env.SCANNER_PORT ?? 5176);
const MAX_REQUEST_BYTES = Number(process.env.SCANNER_MAX_REQUEST_BYTES ?? 100_000);
const API_KEY = process.env.SCANNER_API_KEY ?? '';
// An unset key used to disable authentication silently, leaving any reachable
// caller able to run scans with this service's ADAPT credentials. Running
// without a key is now an explicit, deliberate opt-in.
const ALLOW_UNAUTHENTICATED = process.env.SCANNER_ALLOW_UNAUTHENTICATED === '1';
if (!API_KEY && !ALLOW_UNAUTHENTICATED) {
  console.error(
    '[adapt-a11y-scanner] refusing to start: set SCANNER_API_KEY, or set ' +
      'SCANNER_ALLOW_UNAUTHENTICATED=1 to intentionally run without auth.',
  );
  process.exit(1);
}

// Messages runAdaptScan raises for invalid requests rather than infrastructure
// failure. Kept explicit so a genuine server fault is never masked as a 400.
const CLIENT_CORRECTABLE = [
  'needs assignmentId',
  'must be "question" or "assignment"',
];

const server = createServer(async (req, res) => {
  setSecurityHeaders(res);
  if (req.method === 'GET' && req.url === '/healthz') {
    json(res, 200, { ok: true });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/adapt/scan') {
    json(res, 404, { error: 'not_found' });
    return;
  }
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  // Request parsing and the scan itself are separated so their failures get
  // different statuses: previously a Chromium crash, an unreachable
  // remedy-server or an ADAPT 5xx all surfaced as 400, so a caller that sent a
  // perfectly valid body could not tell its own mistake from a retryable
  // server-side fault.
  let scan: AdaptScanRequest;
  try {
    scan = parseRequest(await readJson(req));
  } catch (e) {
    const message = (e as Error).message;
    const status = (e as Error & { tooLarge?: boolean }).tooLarge ? 413 : 400;
    json(res, status, { ok: false, error: message });
    return;
  }

  try {
    const report = await runAdaptScan(scan);
    json(res, 200, { ok: report.exitCode === 0, ...report });
  } catch (e) {
    const message = (e as Error).message;
    // runAdaptScan also raises client-correctable configuration errors (e.g. a
    // question scan in SPA mode without an assignmentId). Those are the
    // caller's to fix, so they must not be reported as server faults.
    if (message === 'ADAPT assignment id must be a positive integer' ||
        CLIENT_CORRECTABLE.some((fragment) => message.includes(fragment))) {
      json(res, 400, { ok: false, error: message });
      return;
    }
    console.error('[adapt-a11y-scanner] scan failed:', message);
    json(res, 500, { ok: false, error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[adapt-a11y-scanner] listening on http://${HOST}:${PORT}`);
});

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) {
      // Tagged rather than matched on message text: the 413 mapping below used
      // to sniff for "exceeds", so a reworded message would have silently
      // downgraded oversized requests to 400.
      const err = new Error(`Request body exceeds ${MAX_REQUEST_BYTES} bytes.`) as Error & {
        tooLarge?: boolean;
      };
      err.tooLarge = true;
      throw err;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function parseRequest(body: Record<string, unknown>): AdaptScanRequest {
  const mode = body.mode;
  if (mode !== 'question' && mode !== 'assignment') {
    throw new Error('mode must be "question" or "assignment".');
  }
  const id = body.id;
  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new Error('id must be a string or number.');
  }
  const assignmentId = body.assignmentId ?? body.assignment_id;
  if (assignmentId != null && typeof assignmentId !== 'string' && typeof assignmentId !== 'number') {
    throw new Error('assignmentId must be a string or number when provided.');
  }
  return { mode, id, assignmentId: assignmentId ?? undefined };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
}
