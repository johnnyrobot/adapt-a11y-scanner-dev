// Synthetic failure-only diagnostic, under the exact tested container policy.
// Does not replace the actual renderer acceptance suite or relax its sandbox.
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const result = { uid: process.getuid(), node: process.version, platform: process.platform, arch: process.arch };
result.status = (await readFile('/proc/self/status', 'utf8')).split('\n').filter(line => /^(Uid|CapEff|NoNewPrivs|Seccomp|Seccomp_filters):/.test(line));
for (const path of ['/proc/sys/kernel/unprivileged_userns_clone', '/proc/sys/user/max_user_namespaces']) {
  try { result[path] = (await readFile(path, 'utf8')).trim(); } catch (error) { result[path] = error.code; }
}
try {
  execFileSync('unshare', ['--user', '--map-root-user', '--pid', '--fork', 'true'], { timeout: 5000, encoding: 'utf8' });
  result.unshare = 'success';
} catch (error) { result.unshare = { code: error.status, stderr: String(error.stderr) }; }
try {
  const browser = await chromium.launch({ chromiumSandbox: true, timeout: 5000 });
  result.launch = 'success'; await browser.close();
} catch (error) { result.launch = error.message; process.exitCode = 1; }
await writeFile('/evidence/launch-diagnostic.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
