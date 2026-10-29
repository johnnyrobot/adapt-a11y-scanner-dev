# Linux amd64 shipping-runtime gate (LT-146)

This gate builds the exact production Dockerfile and runs the actual compiled
renderer, job, CLI and HTTP server inside that image. External ADAPT and Remedy
are synthetic loopback fixtures inside the container. The container has no
external network. This is component runtime proof, not assembled-stack or live
ADAPT/Remedy compatibility. LT-114 and LT-111 remain open.

## Reproduce and inspect

The `Shipping runtime` GitHub workflow runs on Ubuntu 22.04, Linux amd64. It
builds with buildx `--load --platform linux/amd64`, retaining the Dockerfile's
non-root `pwuser`, production-only dependencies, compiled dist and bundled
Playwright/Chromium. The test runner replaces the entrypoint with Node to run
read-only mounted tests; CLI/API tests execute the actual dist entrypoints.
Pinned MathJax dev assets are mounted read-only strictly as fixture data, not
installed into the shipping image. No host browser or host dist is used.

Download `scanner-linux-amd64-shipping-runtime` from the workflow run. It includes
the tested commit, Dockerfile/lock/profile hashes, build log, build metadata
(manifest digest and provenance), image inspect (config image ID), container
runtime flags and exit state, full test output, observer responses, and actual
Chromium namespace/seccomp/PGID evidence. Distinguish the manifest digest from
the image config ID. This job does not publish an image to a registry; recording
these hashes does not by itself deliver a deployable registry reference.

The proof requires all of:

- Container non-root, reaping init at PID1, zero effective capabilities,
  `no-new-privileges`, seccomp filter mode, cap_drop ALL and a 20-second stop grace.
- Actual Chromium launch with the sandbox enabled, distinct renderer user and
  PID namespaces from both browser and container parent, NoNewPrivs 1, and
  **more seccomp filters** than the browser/container baseline. Inherited
  Seccomp 2 alone never passes.
- Browser and reported Chromium children in the pre-owned worker PGID. Actual
  killed descendants must disappear before capacity is released; waiting on
  their disappearance also proves the container init reaps orphaned members.
- Real math/capture/contracts and CLI/API behavior, admission overload,
  disconnects, deadlines, startup hangs, retained capacity during forced cleanup,
  and shutdown within 15 seconds. Missing prerequisites fail; none are skipped.
- A second container running actual dist/server.js with a synthetic fixture
  preload: Docker stop through init returns unsuccessful 503 for admitted and
  queued callers, exits 0 in less than 15 seconds, under a 20-second grace.

Unprivileged sandbox processes can deny namespace-link reads. A **read-only
observer on the CI host** obtains host PIDs from `docker top` for the one managed
test container, matches its container PID via host NSpid, and reads those exact
namespace links. Only this observation uses host sudo. No root user, extra
capability, privileged mode or relaxed policy is given to the container. Observer
failure or unavailable evidence fails the tests. Request/response files contain
synthetic process metadata only and are written atomically.

## Audited seccomp policy

`deploy/chromium-seccomp-amd64.json` derives from the official Playwright
v1.60.0 Docker seccomp profile, source commit
`87bb9ddbd78f329df18c2b24847bc9409240cd07`, blob
`fddc05fb520affb145404e6f6f647ca96af8087d`:

<https://github.com/microsoft/playwright/blob/87bb9ddbd78f329df18c2b24847bc9409240cd07/utils/docker/seccomp_profile.json>

Upstream file SHA-256:
`cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`.
Playwright is Apache-2.0 licensed; retain this attribution with redistributed
policy copies. This is a default-deny Docker syscall baseline with the official
three-call namespace exception (clone, setns, unshare). The local audit narrows
architecture metadata to amd64/x86 compatibility, removes capability-dependent
allowances (cap_drop ALL is mandatory) and irrelevant architecture allowances,
and returns ENOSYS for clone3. clone3 is not allowed: its pointed-to flags cannot
be filtered directly; ENOSYS allows the existing clone fallback used by libc.
No mount, kernel-module, keyring, bpf or other privileged syscall exception is
added. This is a namespace-capable baseline, not a claim of a minimal per-Node
syscall allowlist or a general container-escape defense.

The host must already support unprivileged user/PID namespaces and Chromium's
seccomp sandbox. AppArmor/LSM, kernel, rootless Docker, userns-remap or nested
container policies can still deny startup. The CI result only proves its recorded
host/runtime. If the target host fails, stop and return the exact failure for
platform policy review. Never use privileged, SYS_ADMIN, seccomp unconfined,
CHROMIUM_NO_SANDBOX, a no-sandbox flag or host-wide policy relaxation to pass.

## Settings for the stack owner

Do not deploy this test harness. Copy the reviewed profile to a versioned
absolute host path and pin the tested application image after the release owner
publishes it. In the Server-owned stack, carry these settings:

```yaml
adapt-scanner:
  image: <published scanner image at immutable manifest digest>
  entrypoint: [node, dist/server.js]
  init: true
  stop_grace_period: 20s
  cap_drop: [ALL]
  security_opt:
    - no-new-privileges:true
    - seccomp:${SCANNER_SECCOMP_PROFILE:?absolute reviewed host profile path required}
  shm_size: 1gb
  environment:
    SCAN_MODE: http
    SCANNER_MAX_ACTIVE_JOBS: '1'
    SCANNER_MAX_QUEUED_JOBS: '8'
    SCANNER_JOB_TIMEOUT_MS: '900000'
```

Preserve image USER pwuser; do not override it with root. Leave sandbox opt-out
and unauthenticated scanner opt-in unset. Set SCANNER_API_KEY, ADAPT_BASE_URL,
ADAPT_TOKEN, REMEDY_ENDPOINT and REMEDY_API_KEY through the stack's existing
secret/config mechanism. REMEDY_API_KEY must match Server APP_API_KEY. Production
uses the Server full runtime HTML validator endpoint, not runtime-slim. Configure
the stack network instead of the test-only `network: none`; route only trusted
callers to the authenticated scanner. Service-token issuance/rotation remains a
separate operator step.

Synchronous proxy/client timeouts must exceed the chosen total job deadline plus
cleanup allowance (five seconds, or ten if shutdown interrupts startup). For the
default 900000ms deadline, use a value above 910 seconds. Each replica owns its
own admission budget; size downstream Server capacity accordingly. Healthz
proves admission availability, not live ADAPT/Server compatibility.

The local one-shot Compose example includes the same security settings; export
SCANNER_SECCOMP_PROFILE as an absolute host path before invoking it. Compose path
interpolation is separate from the service's env_file.

## Remaining release gates

No arm64, rootless/userns-remap, Podman, Kubernetes, full-stack or live compatibility
claim is made. The stack owner still must apply/test the exact profile and
settings in the assembled Linux topology, publish/pin compatible images and
patches, verify real source contracts and the actual-service synthetic workflow,
and deliver reviewed preflight, storage/backup, upgrade, verification and rollback
instructions. A local rebuild or changed image/profile/kernel needs fresh proof.
This repo does not modify Server deploy/stack or authorize deployment.
