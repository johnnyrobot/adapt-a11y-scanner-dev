import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const [layout, path, allowed] of [
  ['classic', 'app/dist/server.js', true],
  ['oci', 'app/src/server.ts', true],
  ['classic', 'app/.env', false],
  ['oci', 'app/test/credentials.json', false],
  ['oci', 'app/runtime-evidence/trace.zip', false],
]) {
  test(`saved ${layout} layers ${allowed ? 'accept production' : 'reject deleted private'} path ${path}`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'scanner-candidate-layers-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, 'candidate-image'));
    const fixture = spawnSync('python3', ['-c', `
import io, json, tarfile, sys
layers = ['a/layer.tar', 'b/layer.tar'] if sys.argv[1] == 'classic' else ['blobs/sha256/a', 'blobs/sha256/b']
def add(archive, name, content):
    entry = tarfile.TarInfo(name); entry.size = len(content)
    archive.addfile(entry, io.BytesIO(content))
with tarfile.open('candidate-image/image.tar.gz', 'w:gz') as archive:
    for name, path in zip(layers, [sys.argv[2], 'app/.wh.' + sys.argv[2].split('/')[-1]]):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w') as layer: add(layer, path, b'synthetic')
        add(archive, name, data.getvalue())
    add(archive, 'manifest.json', json.dumps([{'Layers': layers}]).encode())
`, layout, path], { cwd: dir, encoding: 'utf8' });
    assert.equal(fixture.status, 0, fixture.stderr);
    const result = spawnSync('python3', [resolve('.github/scripts/check-image-archive.py')], { cwd: dir, encoding: 'utf8' });
    if (allowed) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).layersChecked, 2);
    } else {
      assert.notEqual(result.status, 0, 'private content in an older layer must fail even after deletion');
      assert.ok(result.stderr.includes(path));
    }
  });
}
