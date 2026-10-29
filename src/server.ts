#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig } from './config.js';
import { JobLifetime, ShutdownError } from './lifecycle.js';
import { ScanAdmission, UnavailableError } from './admission.js';
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

const cfg = loadConfig();
if (cfg.scanMode !== 'http') throw new Error('HTTP scan server requires SCAN_MODE=http for cancellable validation; in-process is CLI-only.');
const admission = new ScanAdmission(cfg.maxActiveJobs, cfg.maxQueuedJobs);

// Messages runAdaptScan raises for invalid requests rather than infrastructure
// failure. Kept explicit so a genuine server fault is never masked as a 400.
const CLIENT_CORRECTABLE = [
  'needs assignmentId',
  'must be "question" or "assignment"',
];

const server = createServer(async (req, res) => {
  setSecurityHeaders(res);
  if (req.method === 'GET' && req.url === '/healthz') {
    json(res, admission.accepting ? 200 : 503, { ok: admission.accepting });
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

  const disconnected = new AbortController();
  const onDisconnect = () => {
    if (!res.writableEnded) disconnected.abort(new Error('Scan caller disconnected'));
  };
  res.once('close', onDisconnect);
  const lifetime = new JobLifetime(cfg.jobTimeoutMs, disconnected.signal);
  try {
    const report = await admission.submit(lifetime, async () => {
      let scan: AdaptScanRequest;
      try { scan = parseRequest(await readJson(req, lifetime)); }
      catch (error) { throw Object.assign(error as Error, { clientInput: true }); }
      lifetime.check();
      return runAdaptScan(scan, lifetime);
    });
    json(res, 200, { ok: report.exitCode === 0, ...report });
  } catch (e) {
    const error = e as Error & { tooLarge?: boolean; clientInput?: boolean };
    const message = error.message;
    // Rejected/expired uploads must not keep draining outside admitted capacity.
    if (e instanceof UnavailableError || lifetime.signal.aborted || error.tooLarge) res.shouldKeepAlive = false;
    if (e instanceof UnavailableError || lifetime.signal.reason instanceof ShutdownError) {
      res.setHeader('retry-after', '5');
      json(res, 503, { ok: false, error: message });
    } else if (lifetime.signal.aborted) {
      json(res, 504, { ok: false, error: message });
    } else if (error.tooLarge || error.clientInput || message === 'ADAPT assignment id must be a positive integer' ||
        CLIENT_CORRECTABLE.some(fragment => message.includes(fragment))) {
      json(res, error.tooLarge ? 413 : 400, { ok: false, error: message });
    } else {
      console.error('[adapt-a11y-scanner] scan failed:', message);
      json(res, 500, { ok: false, error: message });
    }
  } finally {
    res.removeListener('close', onDisconnect);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[adapt-a11y-scanner] listening on http://${HOST}:${(server.address() as { port: number }).port}`);
});

async function readJson(req: IncomingMessage, lifetime: JobLifetime): Promise<Record<string, unknown>> {
  lifetime.check();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = () => {
      req.removeListener('data', data); req.removeListener('end', end);
      req.removeListener('error', fail); lifetime.signal.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => { cleanup(); req.resume(); reject(error); };
    const abort = () => fail(lifetime.signal.reason);
    const data = (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BYTES) fail(Object.assign(new Error(`Request body exceeds ${MAX_REQUEST_BYTES} bytes.`), { tooLarge: true }));
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(error); }
    };
    req.on('data', data); req.once('end', end); req.once('error', fail);
    lifetime.signal.addEventListener('abort', abort, { once: true });
  });
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
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
}

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  admission.stop();
  // Browser cleanup escalates at five seconds; startup has a five-second bound.
  // Keep answering readiness/admission during drainage, then stop all sockets.
  const hardStop = setTimeout(() => {
    console.error('[adapt-a11y-scanner] shutdown did not drain within 15s');
    server.closeAllConnections();
    process.exit(1);
  }, 15000);
  const drain = setInterval(() => {
    if (!admission.idle) return;
    clearInterval(drain);
    server.closeAllConnections();
    server.close(() => { clearTimeout(hardStop); });
  }, 20);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
