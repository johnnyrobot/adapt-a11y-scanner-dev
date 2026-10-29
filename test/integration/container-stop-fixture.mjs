// Preload synthetic loopback providers for the actual dist/server.js process.
// No production modules are replaced. The fixture cannot keep the server alive.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';

const fixture = createServer(async (req, res) => {
  if (req.url === '/api/get-header-html/1') {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Synthetic shutdown</title><p>Actual capture before stop</p>');
  } else if (req.url === '/validate') {
    await writeFile('/evidence/stop-validation-reached', 'actual capture submitted\n');
    // Keep the actual HTTP validation in flight until shutdown aborts it.
  } else { res.writeHead(404).end(); }
});
fixture.on('connection', socket => socket.unref());
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening'); fixture.unref();
const base = `http://127.0.0.1:${fixture.address().port}`;
Object.assign(process.env, {
  ADAPT_BASE_URL: base, ADAPT_TOKEN: 'synthetic-token', SCAN_MODE: 'http',
  RENDER_MODE: 'iframe', REMEDY_ENDPOINT: `${base}/validate`, REMEDY_API_KEY: 'synthetic-key',
  SCANNER_API_KEY: 'synthetic-key', SCANNER_HOST: '127.0.0.1', SCANNER_PORT: '5176',
  SCANNER_MAX_ACTIVE_JOBS: '1', SCANNER_MAX_QUEUED_JOBS: '1', SCANNER_JOB_TIMEOUT_MS: '30000',
});
// A loopback caller in the same process can persist its actual 503 responses
// before Node exits; a docker-exec caller could be killed when PID1 exits.
setTimeout(() => { void import('./container-stop-client.mjs').catch(error => {
  console.error(error); process.exitCode = 1;
}); }, 0);
