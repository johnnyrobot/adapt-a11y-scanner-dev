// Public, synthetic build identity only. Never copy workflow env or registry auth.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const sha256 = async path => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.match(source, /^[a-f0-9]{40}$/);
assert.equal(source, process.env.GITHUB_SHA);
const files = ['Dockerfile', '.dockerignore', 'package-lock.json', 'deploy/chromium-seccomp-amd64.json'];
const inputs = Object.fromEntries(await Promise.all(files.map(async path => [path, await sha256(path)])));
const inputHash = createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
const base = (await readFile('Dockerfile', 'utf8')).match(/^FROM (\S+@sha256:[a-f0-9]{64})$/m)?.[1];
assert.ok(base, 'production base must be digest-pinned');
const image = 'ghcr.io/johnnyrobot/adapt-a11y-scanner-dev-candidate';
const tag = `non-release-${source}-${inputHash}`;
const mode = process.argv[2];
const path = 'candidate-image/identity.json';

if (mode === 'create') {
  const [config] = await read('runtime-evidence/image.json');
  assert.equal(config.Config.User, 'pwuser');
  assert.equal(config.Os, 'linux'); assert.equal(config.Architecture, 'amd64');
  assert.equal(config.Config.Labels['org.libretexts.release-status'], 'non-release-candidate');
  assert.equal(config.Config.Labels['org.opencontainers.image.revision'], source);
  for (const item of config.Config.Env) {
    assert.ok(!/^(ADAPT_|REMEDY_|SCANNER_API_KEY=|NODE_OPTIONS=|SANDBOX_|GITHUB_TOKEN=)/.test(item), 'no credentials or test configuration in image');
  }
  const record = { status: 'NON-RELEASE CANDIDATE', source, base, inputs, inputHash, image, tag,
    configId: config.Id, archiveSha256: await sha256('candidate-image/image.tar.gz') };
  await writeFile(path, JSON.stringify(record, null, 2) + '\n');
  await copyFile('runtime-evidence/build.json', 'candidate-image/build.json');
} else {
  const record = await read(path);
  assert.equal(record.source, source); assert.equal(record.base, base);
  assert.deepEqual(record.inputs, inputs); assert.equal(record.inputHash, inputHash);
  assert.equal(record.image, image); assert.equal(record.tag, tag);
  assert.equal(record.status, 'NON-RELEASE CANDIDATE');
  assert.match(record.configId, /^sha256:[a-f0-9]{64}$/);
  if (mode === 'validate') {
    assert.equal(await sha256('candidate-image/image.tar.gz'), record.archiveSha256);
    // Only fixed, validated values enter GitHub's output file.
    await writeFile(process.env.GITHUB_OUTPUT, `image=${image}\ntag=${tag}\nconfig-id=${record.configId}\n`, { flag: 'a' });
  } else if (mode === 'report') {
    const digest = (await readFile('registry-evidence/digest.txt', 'utf8')).trim();
    assert.match(digest, /^sha256:[a-f0-9]{64}$/);
    const [pulled] = await read('registry-evidence/image.json');
    assert.equal(pulled.Id, record.configId, 'pulled image must be the initially tested config');
    assert.ok(pulled.RepoDigests.includes(`${image}@${digest}`));
    const visibility = (await readFile('registry-evidence/visibility.txt', 'utf8')).trim();
    assert.ok(['public', 'private'].includes(visibility));
    await writeFile('registry-evidence/candidate.json', JSON.stringify({ ...record,
      manifestDigest: digest, pullReference: `${image}@${digest}`, visibility,
      visibilityEvidence: 'exact authenticated manifest exists; anonymous registry read allowed or denied',
      workflowRun: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
      releaseGates: 'LT-114/LT-111 open: assembled stack, target host, credential rollout and global release approval pending',
    }, null, 2) + '\n');
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `NON-RELEASE CANDIDATE; LT-114/LT-111 remain open.\n\nPull: \`${image}@${digest}\`\n\nSource: \`${source}\`; visibility: ${visibility}. See candidate.json for base/input hashes and distinct config ID. Exact pulled image passed the shipping proof.\n`, { flag: 'a' });
  } else throw new Error('unknown record operation');
}
