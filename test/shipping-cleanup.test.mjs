import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const [observerStatus, bodyStatus] of [[23, 0], [23, 7], [0, 0]]) {
  test(`shipping EXIT retains diagnostics and failure (observer=${observerStatus}, body=${bodyStatus})`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'scanner-shipping-trap-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    // Stub Docker's external interface only; run the real Bash -e EXIT handler
    // and a real child observer that exits unsuccessfully.
    await writeFile(join(dir, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$1 diagnostic"\n', { mode: 0o755 });
    const result = spawnSync('bash', ['-e', '-c', `
      source "$1"
      (exit "$3") &
      observer=$!
      trap 'finish_observer "$?" "$observer" "$2" scanner-proof' EXIT
      exit "$4"
    `, 'test', resolve('.github/scripts/observer-cleanup.sh'), dir, String(observerStatus), String(bodyStatus)], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, bodyStatus || observerStatus, result.stderr);
    assert.equal(await readFile(join(dir, 'container-final.json'), 'utf8'), 'inspect diagnostic\n');
    assert.equal(await readFile(join(dir, 'test.log'), 'utf8'), 'logs diagnostic\n');
    assert.equal(await readFile(join(dir, 'observer-stop'), 'utf8'), '');
  });
}
