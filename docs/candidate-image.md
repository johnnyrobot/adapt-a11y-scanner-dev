# NON-RELEASE scanner image candidate (LT-155)

The main-only **Non-release candidate image** workflow publishes a Linux amd64
component candidate in `ghcr.io/johnnyrobot/adapt-a11y-scanner-dev-candidate`.
It is not a production release or deployment approval. LT-114 and LT-111 remain
open for assembled-stack, target-host, credential rollout and global approval.
No `latest` tag, upstream namespace or deployment is used.

After the reviewed PR merges, dispatch this workflow on `main`:

```bash
gh workflow run candidate-image.yml --repo johnnyrobot/adapt-a11y-scanner-dev --ref main
```

Only a dispatch on this repository's main can run its jobs. There are no supplied
refs, artifact IDs or namespace inputs. Native CI and the complete shipping gate
must pass for that exact source before publication. The successful shipping job
saves its tested image, hashes the archive and audits every layer. The publish
job consumes only that artifact from the same run, validates source/input/archive
identity and loads the saved image. It never rebuilds. Package write permission
exists only in the publish job; registry authentication uses the existing
short-lived GitHub token and is cleared after the attempt. No new token, account,
provider or billing setup is involved.

The Dockerfile pins the previously tested Playwright base by digest. A production
build-context allowlist admits only Dockerfile, package manifests, TypeScript
configuration and source. Tests, env files, raw traces, host dependencies and
evidence never enter the context. Fixture tests and MathJax are mounted read-only
after build. No fixture credentials are installed in the image. Every saved
layer, including deleted files, is checked for owned env/fixture/evidence paths;
image configuration is checked for credentials and test environment settings.

Tags have this identity:

```text
non-release-<full source commit SHA>-<full SHA256 of input hashes>
```

The combined hash covers Dockerfile, .dockerignore, package-lock.json and the
reviewed seccomp profile. The candidate record includes each file's hash, full
source, pinned base, archive hash and image config ID. Workflow runs serialize;
publication refuses any already-used tag. GHCR itself does not enforce tag
immutability, so consumers must always use the recorded manifest digest.

After push, the job resolves the registry manifest digest and pulls that exact
reference. It verifies the config ID matches the initially tested image, then
runs the full actual-image renderer/capture/contracts/lifecycle proof and real
HTTP server Docker-stop proof again against `image@sha256:...`. No host dist or
browser is substituted. Required-profile failures or skips fail the job. Failed
observer cleanup preserves failure status and final inspect/test logs; it cannot
turn a failure into a pass.

The `non-release-candidate-registry-proof` run artifact contains `candidate.json`,
`digest.txt`, `manifest.json`, `image.json`, source/input hashes, actual-image
sandbox evidence, full synthetic test output and Docker-stop evidence. Build
metadata retains the initial local build's manifest digest; the registry manifest
is separately recorded in `digest.txt`/`candidate.json`. Neither is the image
config ID. Treat a pushed image without a successful exact-digest proof as an
**unverified non-release artifact**. Never infer success from push alone.

Read `candidate.json` for the exact pull reference and observed package
visibility; the workflow does not change visibility. For a public package, the
recorded digest pulls anonymously. A private package requires the eventual
operator's existing package read access. Provisioning production pull credentials
or changing package visibility remains an operator decision. If GitHub denies
package creation/write/read access, retain the failed run evidence and ask the
owner to enable this repository's Actions access on this exact package (or allow
its creation). Do not supply another token, namespace or mutable tag as a bypass.

Copy the record's `pullReference` verbatim:

```bash
docker pull --platform linux/amd64 ghcr.io/johnnyrobot/adapt-a11y-scanner-dev-candidate@sha256:<registry manifest digest from candidate.json>
```

Keep the exact reviewed seccomp file beside the deployment bundle and match its
hash to the candidate record. Apply all runtime settings in
[shipping-runtime.md](shipping-runtime.md), including init, non-root pwuser,
cap_drop ALL, no-new-privileges, narrow seccomp, shared memory and stop grace.
The candidate does not establish arm64, rootless Docker, userns-remap, other
container engines, target-host or live ADAPT/Remedy compatibility. A changed
image/profile/source/host needs fresh proof. Never disable auth or the Chromium
sandbox to integrate it.
