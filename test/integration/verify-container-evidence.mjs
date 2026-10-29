import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = process.argv[2];
const read = async name => JSON.parse(await readFile(join(directory, name), 'utf8'));
const [container] = await read('container-final.json');
const [image] = await read('image.json');
const sandbox = await read('sandbox.json');
const build = await read('build.json');
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
assert.ok(container.HostConfig.SecurityOpt.some(value => /^seccomp=/.test(value) && !value.includes('unconfined')));
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
  commit: (await readFile(join(directory, 'commit.txt'), 'utf8')).trim(),
  baselineFilters: sandbox.parent.seccompFilters,
  rendererFilters: sandbox.cases[0].renderers.map(renderer => renderer.seccompFilters) }, null, 2));
