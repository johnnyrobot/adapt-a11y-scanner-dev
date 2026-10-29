import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = process.argv[2];
const read = async name => JSON.parse(await readFile(join(directory, name), 'utf8'));
const [container] = await read('container-final.json');
const [image] = await read('image.json');
const sandbox = await read('sandbox.json');
const build = await read('build.json');
const testLog = await readFile(join(directory, 'test.log'), 'utf8');
const count = name => {
  const matches = [...testLog.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
  assert.equal(matches.length, 1, `one complete TAP summary for ${name} required`);
  return Number(matches[0][1]);
};
const tests = count('tests');
assert.ok(tests > 0);
assert.equal(count('pass'), tests);
for (const name of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(count(name), 0, name);

assert.equal(image.Os, 'linux'); assert.equal(image.Architecture, 'amd64');
assert.equal(container.Image, image.Id);
assert.equal(container.Config.User, 'pwuser');
assert.equal(container.HostConfig.Init, true);
assert.equal(container.HostConfig.Privileged, false);
assert.deepEqual(container.HostConfig.CapDrop, ['ALL']);
assert.ok(!container.HostConfig.CapAdd?.length);
assert.equal(container.HostConfig.NetworkMode, 'none');
assert.equal(container.HostConfig.PidMode, '');
assert.equal(container.HostConfig.UsernsMode, '');
assert.equal(container.Config.StopTimeout, 20);
assert.ok(container.HostConfig.SecurityOpt.includes('no-new-privileges=true'));
assert.equal(container.HostConfig.SecurityOpt.length, 2, 'no extra security-policy relaxation');
const seccomp = container.HostConfig.SecurityOpt.find(value => value.startsWith('seccomp='));
assert.ok(seccomp && !seccomp.includes('unconfined'));
assert.deepEqual(JSON.parse(seccomp.slice('seccomp='.length)),
  JSON.parse(await readFile('deploy/chromium-seccomp-amd64.json', 'utf8')),
  'Docker must report exactly the reviewed profile');
assert.ok(container.Mounts.filter(mount => mount.Destination !== '/evidence').every(mount => mount.RW === false));
assert.equal(container.State.ExitCode, 0);
assert.equal(container.State.OOMKilled, false);
assert.ok(/^sha256:[a-f0-9]{64}$/.test(build['containerimage.digest']));
assert.ok(/^sha256:[a-f0-9]{64}$/.test(image.Id));
assert.equal(sandbox.parent.seccomp, '2');
assert.equal(sandbox.parent.noNewPrivs, '1');
assert.equal(sandbox.cases.length, 1, 'shipping proof never launches an opted-out browser');
assert.ok(sandbox.cases[0].renderers.length > 0);
for (const renderer of sandbox.cases[0].renderers) {
  assert.ok(renderer.seccompFilters > sandbox.parent.seccompFilters);
  assert.notEqual(renderer.userNamespace, sandbox.parent.userNamespace);
  assert.notEqual(renderer.pidNamespace, sandbox.parent.pidNamespace);
}
console.log(JSON.stringify({ image: image.Id, manifest: build['containerimage.digest'],
  tests, skipped: 0,
  commit: (await readFile(join(directory, 'commit.txt'), 'utf8')).trim(),
  baselineFilters: sandbox.parent.seccompFilters,
  rendererFilters: sandbox.cases[0].renderers.map(renderer => renderer.seccompFilters) }, null, 2));
