#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { runAdaptScan, type AdaptScanRequest } from './job.js';

const HOST = process.env.SCANNER_HOST ?? '0.0.0.0';
const PORT = Number(process.env.SCANNER_PORT ?? 5176);
const MAX_REQUEST_BYTES = Number(process.env.SCANNER_MAX_REQUEST_BYTES ?? 100_000);
const API_KEY = process.env.SCANNER_API_KEY ?? '';

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

  try {
    const body = await readJson(req);
    const scan = parseRequest(body);
    const report = await runAdaptScan(scan);
    json(res, 200, { ok: report.exitCode === 0, ...report });
  } catch (e) {
    json(res, 400, { ok: false, error: (e as Error).message });
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
      throw new Error(`Request body exceeds ${MAX_REQUEST_BYTES} bytes.`);
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
