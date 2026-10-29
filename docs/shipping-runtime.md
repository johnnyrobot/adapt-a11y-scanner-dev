# Linux amd64 shipping-runtime gate (LT-146)

This gate builds the exact production Dockerfile and runs the actual compiled
renderer, job, CLI and HTTP server inside that image. External ADAPT and Remedy
are synthetic loopback fixtures inside the container. The container has no
external network. This is component runtime proof, not assembled-stack or live
ADAPT/Remedy compatibility. LT-114 and LT-111 remain open.

## Verified component evidence

[Shipping run 40879204497](https://github.com/johnnyrobot/adapt-a11y-scanner-dev/actions/runs/40879204497)
passed at commit `ff586dd0ff511223e005bbaa71d02d505dc326c8`:
70 actual in-image checks passed, zero failed/skipped. The artifact verifier was
also rerun against the downloaded evidence. Host: Ubuntu 22.04, Linux
6.8.0-1070-azure x86_64, Docker 28.0.4. Shipping runtime: Node 24.15.0,
Playwright 1.60.0, Chromium 148.0.7778.96.

| Evidence | Recorded value |
|---|---|
| Built manifest digest | `sha256:62582f9cfc407dc3c24b0e87f3c1d4d8a420abb819fef4e5679dec9007ce65ac` |
| Image config ID | `sha256:78cde6da5a5fa3d39f3265a31b5f5a91ae3c0318bf0f12171e55bea2faf30220` |
| Resolved Playwright base digest | `sha256:e1529a04087193966ea15d4a1617345bdaa0791690a24ab2c42b65f9ce5b2cdc` |
| Reviewed/applied seccomp file SHA-256 | `d4447d241bf9c65e1698fc8508438c128dc000e3b0519b8e12e4afa4c8ae5d44` |
| Parent/browser vs renderer filter count | `1` vs `2`; all Seccomp 2, NoNewPrivs 1, UID 1000, effective capabilities 0 |
| Browser/GPU/network/renderer PGID | `62`, matching owned worker PID `62` |
| Actual Docker stop | `119ms`, exit 0, two truthful HTTP 503/ok:false responses, 20-second grace |

Actual renderer user/PID namespace identities differ from the parent/browser;
the artifact retains host/container PID mapping and links. Absolute PID/namespace
numbers above are observations of this run, not configuration. Later commits
adding documentation do not change the recorded tested commit. A new CI build
records its own digests; these hashes do not identify a published registry image.

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
the image config ID. The standalone shipping job does not publish an image. The main-only
[non-release candidate workflow](candidate-image.md) reuses this gate, publishes
its saved image and repeats all proof against the exact pulled registry digest.
Recording local build hashes alone does not deliver a registry reference.

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
The policy also permits chroot so Chromium can confine itself **inside its new
user namespace**. Kernel capability checks still deny chroot to the non-root,
zero-capability container parent; the shipping test explicitly requires that
denial. No CAP_SYS_CHROOT is added. No mount, kernel-module, keyring or bpf
exception is added. This is a namespace-capable baseline, not a claim of a minimal per-Node
syscall allowlist or a general container-escape defense.

This exception is evidence-backed: actual-image runs 40876802797 and
40877615773 failed under the original profile. The unchanged-policy diagnostic
proved unshare succeeds, while Chromium fails with
`Check failed: sys_chroot("/proc/self/fdinfo/") == 0`. Chromium 148.0.7778.96
`sandbox/linux/services/credentials.cc`, `ChrootToSelfFdinfo`, requires that
call. The original Docker capability-conditioned chroot allowance does not apply
when ALL capabilities are dropped. The narrow syscall exception retains the
same UID, cap_drop ALL, no-new-privileges, namespace and seccomp requirements.
See [Chromium's exact source](https://github.com/chromium/chromium/blob/148.0.7778.96/sandbox/linux/services/credentials.cc).

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
