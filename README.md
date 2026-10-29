# adapt-a11y-scanner

Render LibreTexts **ADAPT** questions headlessly (authenticated, MathJax-aware)
and scan the rendered DOM for **WCAG accessibility issues** with **LibreTexts
Remedy**.

ADAPT renders questions client-side (Vue SPA + MathJax v2), so a static fetch
gets an empty shell. This bridge drives a real headless browser, waits for math
to typeset, captures the question's actual DOM, and hands it to Remedy.

Scanner is the ADAPT rendering/scan component. It does not call CXone or Bridge,
apply fixes, sign reviewer assertions, or restore CXone pages. Its ADAPT/Server
configuration is independent of the Bridge's CXone credentials and write gates.
The surrounding integration retains those capabilities in the maintained stack.

## Integration scope and rollout ownership

The handoff target is the **full integration in one maintained deployment
package**, with review-only as an **optional** rollout mode. LibreTexts chooses
rollout timing. This does not require an engine-only or review-only first
rollout, a separate build, or a separate data format.

Implementation delivery, a tested component profile, and production writes
being enabled are separate states. **Automatic CXone writes remain gated** on
vendor atomicity/conditional-write confirmation and authorized validation by
**LibreTexts' integration/deployment team**. That is an unresolved integration
requirement, not a Johnny approval checkpoint. Signing, apply, restore and
recovery paths remain part of the full integration; optional review-only use
does not remove them. This README neither enables writes nor certifies a
full-write production rollout.

## Tested NON-RELEASE candidate

The exact Linux amd64 component candidate is:

```bash
docker pull --platform linux/amd64 ghcr.io/johnnyrobot/adapt-a11y-scanner-dev-candidate@sha256:00ab363669ccc7ae50fe7fc79286508af5923d3326d397f87cff91ee76e379a6
```

Source: [`1541bb8f3962553b65dab7bfd5aeb429354a8a4f`](https://github.com/johnnyrobot/adapt-a11y-scanner-dev/commit/1541bb8f3962553b65dab7bfd5aeb429354a8a4f).
[Candidate run 40901392425](https://github.com/johnnyrobot/adapt-a11y-scanner-dev/actions/runs/40901392425)
passed 73 helper checks, 74 native browser checks, 70 initial image checks and
70 repeated checks against the exact pulled registry digest, with no failures
or skips. The run observed public anonymous pull access.
[Proof artifact / candidate.json](https://github.com/johnnyrobot/adapt-a11y-scanner-dev/actions/runs/40901392425/artifacts/12908759433)
records the source, base/input hashes, visibility and manifest/config identities.
The pull digest above is the **registry manifest digest**, not an image config ID.
Retain the record, proof and reviewed profile with the deployment bundle.

Use the reviewed [amd64 seccomp file](deploy/chromium-seccomp-amd64.json), SHA-256
`d4447d241bf9c65e1698fc8508438c128dc000e3b0519b8e12e4afa4c8ae5d44`, with all
settings in the [shipping-runtime guide](docs/shipping-runtime.md): image USER
`pwuser`/UID 1000, reaping init, `cap_drop: [ALL]`, `no-new-privileges`, 1 GiB
shared memory and 20-second stop grace. Leave sandbox opt-out and unauthenticated
mode unset. The proof requires an added renderer seccomp filter and distinct
user/PID namespaces, not merely inherited container filtering.

This is a **NON-RELEASE component**, not an assembled-stack release or a live
ADAPT compatibility claim. The tested host was Ubuntu 22.04/Linux x86_64 with
Docker; arm64, rootless/userns-remap, other container engines and target hosts
remain unverified. A changed image/profile/host needs fresh proof. Later
documentation commits do not change this candidate's source identity or
republish it. See the [candidate provenance/pull guide](docs/candidate-image.md).

```
ADAPT  ──question / assignment id──►  adapt-a11y-scanner
                                       1. service-account login → JWT cookie
                                       2. render question (iframe or SPA), wait for MathJax
                                       3. capture rendered DOM
                                       4. scan ──► Remedy (HTTP service OR bundled core)
                                       ◄── findings (JSON; non-zero exit on errors)
```

## Quick start

Start with local checks; these do not contact a live ADAPT or Remedy instance.
Prerequisites: macOS or Linux, Node >=20, npm and Python 3. Native CI uses Node 22.

```bash
npm ci
npm run typecheck
DOTENV_CONFIG_PATH=/dev/null npm test
```

For the actual renderer/job/API tests, install the locked browser and run the
synthetic fixture suite:

```bash
npx --no-install playwright install chromium
npm run test:browser
```

Linux also needs Playwright's system dependencies and sandbox prerequisites.
The candidate already includes its matching browser. Follow the shipping guide
for its reviewed runtime settings; a local rebuild has a new image identity and
needs its own proof.

Before scanning an approved environment, configure the names below using your
secret/config mechanism. `.env.example` is a configuration template, not a
verified target. Service-token issuance/rotation and endpoint authorization
belong to the deployment team. Do not put secrets in source, logs or reports.

This scanner is one of three repositories that make up the Remedy stack:

| Repository | Role |
|---|---|
| `libretexts-remedy-server` | the engine — all checking and remediation behind `/v1/*` |
| `libretexts-remedy-bridge` | CXone Expert page I/O (not needed to scan ADAPT) |
| **`adapt-a11y-scanner`** | this repo — headless ADAPT rendering + scan |

The Server owner maintains the
[assembled-stack integration/deployment guide](https://github.com/johnnyrobot/libretexts-remedy-server-dev/blob/main/deploy/stack/README.md).
The assembled deployment bundle must include reviewed service/patch pins,
networks, preflight, storage/backups, upgrades and rollback. The current Scanner candidate
does not approve provisional stack configuration; an assembled-stack/target-host
proof and reviewed backup/upgrade/rollback handoff remain release requirements.

To run this scanner as a one-shot job against a server you already have, see
[`deploy/docker-compose.example.yml`](deploy/docker-compose.example.yml) (join the
server's network, or point `REMEDY_ENDPOINT` at its public Caddy endpoint). That
example also requires the sandbox runtime policy described below. The
server must run its full `runtime` image — the `runtime-slim` target disables
`/v1/validate/html`.

## Configuration (all via env — see `.env.example`)

| Var | Purpose |
|---|---|
| `ADAPT_BASE_URL` | ADAPT instance, e.g. `https://adapt.libretexts.org` |
| `ADAPT_TOKEN` | **Preferred** — service-account JWT (set as ADAPT's `token` cookie) |
| `ADAPT_EMAIL`/`ADAPT_PASSWORD` | Fallback login (dev/bootstrap only — issue a token in prod) |
| `RENDER_MODE` | `iframe` (render `/api/get-header-html/{id}` directly, fast) or `spa` |
| `SCAN_MODE` | `http` (POST DOM to remedy-server) or `in-process` (optional remedy-core, **dev CLI-only**) |
| `REMEDY_ENDPOINT` | remedy-server URL when `SCAN_MODE=http` |
| `REMEDY_API_KEY` | **Required for `http`** — remedy-server API key, sent as `X-API-Key` (must equal the server's `APP_API_KEY`) |
| `SCANNER_API_KEY` | required for authenticated HTTP scan requests; separate from ADAPT and Remedy credentials |
| `SCANNER_HOST` / `SCANNER_PORT` | HTTP bind address/port (defaults `0.0.0.0` / `5176`); expose only to trusted callers |
| `SCANNER_MAX_REQUEST_BYTES` | maximum HTTP request body, default `100000` bytes |
| `SCANNER_MAX_ACTIVE_JOBS` / `SCANNER_MAX_QUEUED_JOBS` | per-process HTTP admission limits (defaults `1` / `8`, finite positive integers) |
| `SCANNER_JOB_TIMEOUT_MS` | total admitted-job deadline, including queue wait (default `900000` ms) |
| `REMEDY_TIMEOUT_MS` | per-attempt synchronous validation timeout, default `240000` ms, capped by remaining total budget |
| `CHROMIUM_NO_SANDBOX` | deliberate sandbox opt-out (`1` or `true`); leave unset for sandboxed non-root execution |
| `MATHJAX_TIMEOUT_MS` / `NAV_TIMEOUT_MS` | readiness/navigation phase limits, defaults `20000` / `30000` ms, capped by total budget |

### Two scan modes
- **`http`** (default, supported candidate mode): Scanner POSTs the
  rendered HTML to a running **remedy-server** (`POST /v1/validate/html`,
  authenticated with `X-API-Key`) and stays a small stateless renderer. Scales
  independently; no Remedy code bundled. The response mapping in
  `src/scanner.ts` targets the libretexts-remedy-server schema (`all_violations`,
  `overall_passed`).
- **`in-process`** (**dev-only**): imports `@libretexts/remedy-core` and scans
  in the same process. Not wired for production transfer — you must install/link
  that package yourself (it is not a published dependency).

### API, CLI and readiness

After configuring an approved environment, `npm run serve` starts the HTTP API;
the container service entrypoint is `node dist/server.js`. To bind a local
operator instance explicitly, use `SCANNER_HOST=127.0.0.1 npm run serve`.
`POST /v1/adapt/scan` requires `X-API-Key` matching `SCANNER_API_KEY` and a JSON
body such as `{"mode":"question","id":1234}` or
`{"mode":"assignment","id":5678}`. SPA question requests also require
`assignmentId`. Missing/wrong request API keys yield 401. Keep
`SCANNER_ALLOW_UNAUTHENTICATED` unset for the supported profile; it is an explicit
development escape hatch, not a deployment option.

`GET /healthz` is unauthenticated and reports whether admission is accepting
work (200/`ok: true`, or 503 during shutdown). It does not prove spare capacity,
ADAPT login, question readiness or downstream validator availability. A completed
HTTP 200 scan can still have `ok: false`; consume `exitCode`, totals and results.
Request errors use 400/413, fatal job failures 500, overload/shutdown 503
and deadline expiry 504. Retry and cancellation rules are below.

CLI usage after `npm run build`:

```text
node dist/index.js question QUESTION_ID [ASSIGNMENT_ID]
node dist/index.js assignment ASSIGNMENT_ID
```

Exit codes are 0 for passing scans, 1 for unsuccessful/no-work reports, 2 for
usage errors and 3 for fatal failures. CLI output is JSON for completed reports;
fatal errors go to stderr. The CLI does not require `SCANNER_API_KEY`; ADAPT and
Remedy authentication still apply.

### HTTP admission, cancellation and shutdown

The synchronous HTTP server requires `SCAN_MODE=http`. Each process admits one
active job and eight queued jobs by default. Both limits are configurable finite
positive integers. Questions in an assignment stay sequential. Saturation and
stopped admission return HTTP 503, `ok: false`, and `Retry-After: 5`, without
starting a browser or contacting ADAPT/Remedy. `/healthz` returns 503 after
shutdown begins. A disconnected queued caller is removed immediately.

`SCANNER_JOB_TIMEOUT_MS=900000` is one absolute 15-minute deadline beginning at
admission, including queue wait, request parsing, browser startup, authentication,
login, enumeration, navigation, readiness, validation and retry delays. Smaller
phase timeouts still apply; every phase and retry wait is capped to the remaining
budget. Deadline failure returns HTTP 504 with `ok: false`; cancellation stops
later questions and retries. CLI jobs also use this deadline. The dev-only
in-process CLI validator cannot interrupt arbitrary package code; the HTTP server
rejects that mode instead of claiming it can cancel it.

Client disconnect, deadline and SIGINT/SIGTERM abort network requests/retry waits
and close the actual browser. A job retains its active slot until owned browser
process cleanup finishes. Browser startup is bounded to five seconds; cooperative
cleanup gets five seconds before the scanner kills and waits for its owned browser
process group. A private worker is owned before Playwright startup, including a
launch that never returns a browser handle. Browser control listens only on loopback. There is no guessed PID,
global process kill, sandbox fallback or background-job protocol.

Shutdown first stops admission, cancels queued/active jobs, sends truthful 503
failures to connected callers, and drains before closing HTTP sockets. The total
shutdown bound is 15 seconds; a failure to drain exits unsuccessfully. Configure
the stack's stop grace **above 15 seconds** and its synchronous HTTP proxy/client
timeouts above the chosen total job deadline plus cleanup allowance (five
seconds, or ten if shutdown interrupts browser startup). Multiple replicas each
have independent admission limits; the downstream Server owner must size its
capacity accordingly. The local Compose example uses `init: true` and a 20-second stop grace. The
full-stack owner must carry these settings into the deployed stack; this repo
does not validate that stack.

### Chromium sandbox prerequisites

The renderer explicitly enables Chromium's sandbox by default. Run as a
non-root user on Linux with user/PID namespaces and seccomp available. A sandbox
startup failure is returned to the caller; there is no automatic unsandboxed
retry. `CHROMIUM_NO_SANDBOX=1` or `true` deliberately disables this isolation;
it is not a production deployment remedy for missing host prerequisites.

Run the Linux container with a reaping init (`docker run --init` or Compose
`init: true`). The scanner refuses Linux PID1 execution because orphaned browser
processes must be reaped before capacity can be released.

The Dockerfile uses non-root `pwuser` and a browser image matching the locked
Playwright version. Container execution also needs a namespace-capable seccomp
policy; follow [Playwright's non-root container guidance](https://playwright.dev/docs/docker#crawling-and-scraping).
Do not disable sandboxing or host-wide security to make it launch. Native Linux
CI proves the real renderer's launch arguments, namespace/seccomp isolation and
synthetic capture; shipping-container and Compose compatibility require separate
validation before deployment.

The [Linux amd64 shipping-runtime gate](docs/shipping-runtime.md) builds the
actual production Dockerfile and tests its renderer/job/API/CLI inside the image
under the reviewed namespace-capable policy, cap_drop ALL, no-new-privileges and
init. It compares renderer filters/namespaces against the container baseline and
tests Docker stop forwarding under a 20-second grace. Its recorded CI evidence
is component proof; the Server-owned assembled stack still needs validation.

## Trustworthy capture

Question captures require successful HTML at the exact requested ADAPT routes,
including the SPA content frame. HTTP error documents and login/wrong-route
redirects fail before Remedy. Real MathJax v2 startup and a queued Typeset must
complete; incomplete math, unsupported majors and readiness timeouts fail the
question. Genuine no-math/no-library questions remain valid. See the
[LT-118/119 contract and fixture provenance](docs/specs/2026-10-29-trustworthy-capture.md).

## How it authenticates
ADAPT's API guard is JWT (`tymon/jwt-auth`); the SPA reads the JWT from a cookie
named `token`. Scanner sets that cookie from `ADAPT_TOKEN` (or mints one via
`/api/login`). **In production, issue a dedicated service-account token** rather
than using a human password.

## Supported response contracts

Assignment enumeration uses `GET /api/assignments/{id}/questions/ids`, requiring
`type: "success"` and a real `question_ids_array`. IDs must be positive safe
integer numbers or positive decimal-digit strings; strings retain their exact
form. `type: "error"` is unsuccessful even with HTTP 200. The older
`get-questions-info` endpoint returns assignment metadata, not a question list;
guessed list keys and the JSON-encoded `question_ids` duplicate are unsupported.

A recognized empty assignment returns zero totals/results, `exitCode: 1`,
`outcome: "no_work"` and a message. The HTTP API returns 200 with `ok: false`;
the CLI exits 1. Unknown/malformed envelopes are contract errors, not no-work.
Nonempty report fields retain their existing meaning.

Remedy HTTP responses must contain the full typed validation envelope, including
per-tool results. Malformed findings and contradictory clean passes fail before
normalization. Warning and null-impact findings remain warnings; an explicit
false verdict with no findings remains unsuccessful. Human-readable summaries
are never parsed for control flow. The WAVE empty/passed field is a placeholder
in this endpoint, not evidence that WAVE ran.

[LT-120 contract spec](docs/specs/2026-10-29-scan-contracts.md) records the exact
fields and fixtures: Server source `78710dc` and ADAPT source `ee9478b`. These are
supported source snapshots; compatibility with a live deployment still requires
verification. Fixture generation used real Server orchestration/serialization
with synthetic tool adapters, not live tools or HTTP. Fixture `contract_id` is
documentation metadata, not a required field in a Server response.

## Release limits and integration handoff

The published candidate proves Scanner component behavior with synthetic
external ADAPT/Remedy providers, including real Chromium/MathJax and the actual
image entrypoints. It does not prove live authentication, live WCAG accuracy,
the assembled topology, a target host, or production write safety.

LibreTexts' integration/deployment team owns service credentials and rotation,
deployment timing, question-trigger scheduling, finding storage/presentation,
downstream capacity and observability, target-host preflight and the complete
backup/upgrade/rollback plan. Scanner has no database or CXone page snapshots;
those stores and restoration paths belong to the surrounding integration.
Refer to the [Server-owned stack guide](https://github.com/johnnyrobot/libretexts-remedy-server-dev/blob/main/deploy/stack/README.md)
for that maintained handoff. Automatic CXone writes remain subject to the gate
and owner stated above even when the full integration is delivered.

Unavailable in this supported candidate profile: Windows, arm64, other container
engines/rootless layouts without new proof, a public staff UI, bundled
`@libretexts/remedy-core`, alternate validator envelopes, and TestSprite backend
execution through frontend-only local mode. Scanner does not supply a signing
service, CXone write allowlist or write-enable switch; configuring Scanner must
not be presented as enabling those stack features.

## Requirements
- macOS or Linux with Node ≥ 20 (uses built-in `fetch`/`FormData`/`node:test`)
- A reachable ADAPT instance + a service-account token
- A running **remedy-server** with an API key (`SCAN_MODE=http`), or
  `@libretexts/remedy-core` installed (`SCAN_MODE=in-process`, dev-only)

## Tests
`npm test` requires Python 3 for the synthetic Docker/OCI archive checks and
builds/runs the helper suite with `node:test`. It does not need Docker or a
browser. Checks cover
response-mapping/severity (`scanner`), env validation (`config`), and the
fail-closed CI gate (`report`). CI runs typecheck + build + tests
(`.github/workflows/ci.yml`).

`npm run test:browser` additionally exercises real Chromium through the renderer,
job, CLI and HTTP API with loopback fixtures and fake credentials. It verifies
source-backed contracts, no-work, operational failures, sandbox behavior and
actual HTTP admission/cancellation through every phase, queued expiry, deadline
during retry, shutdown and owned process exit. External providers are synthetic
loopback fixtures; cancellation tests inspect activity after abort.
Install the locked browser first
with `npx --no-install playwright install chromium`. The dedicated Ubuntu 22.04 /
Node 22 CI job installs Linux system dependencies, requires non-root execution,
and records actual process arguments plus renderer namespace/seccomp evidence.
It fails if required Linux evidence is unavailable; missing prerequisites are
not skipped. This integration suite currently supports macOS and native Linux;
on macOS it checks launch arguments/capture, not Linux isolation. Linux `/proc`
namespace links may require read-only, passwordless `sudo readlink` inspection;
the scanner and browser remain non-root. No live ADAPT or Remedy is contacted.

The [non-release candidate workflow](docs/candidate-image.md) publishes an
exact-source Linux amd64 component image in johnnyrobot’s GHCR namespace and
reruns shipping proof after pulling its registry digest. Candidate publication
does not close the assembled-stack or production release gates.
