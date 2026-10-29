# adapt-a11y-scanner

Render LibreTexts **ADAPT** questions headlessly (authenticated, MathJax-aware)
and scan the rendered DOM for **WCAG accessibility issues** with **LibreTexts
Remedy**.

ADAPT renders questions client-side (Vue SPA + MathJax v2), so a static fetch
gets an empty shell. This bridge drives a real headless browser, waits for math
to typeset, captures the question's actual DOM, and hands it to Remedy.

```
ADAPT  ──question / assignment id──►  adapt-a11y-scanner
                                       1. service-account login → JWT cookie
                                       2. render question (iframe or SPA), wait for MathJax
                                       3. capture rendered DOM
                                       4. scan ──► Remedy (HTTP service OR bundled core)
                                       ◄── findings (JSON; non-zero exit on errors)
```

## Quick start

```bash
cp .env.example .env        # fill in ADAPT_BASE_URL, ADAPT_TOKEN, REMEDY_ENDPOINT, REMEDY_API_KEY
npm install
npx playwright install chromium   # local browser (the Docker image bundles it)
npm run build

# scan one question
node dist/index.js question 1234

# scan every question in an assignment (gates CI: exit 1 if any errors)
node dist/index.js assignment 5678
```

Container build/CLI example (runtime policy setup required):

First configure the [Chromium sandbox prerequisites](#chromium-sandbox-prerequisites),
including a namespace-capable seccomp policy. The run line below illustrates
CLI arguments; supply that runtime policy before using it.

```bash
docker build -t adapt-a11y-scanner .
docker run --init --cap-drop ALL --security-opt no-new-privileges=true \
  --security-opt seccomp="$PWD/deploy/chromium-seccomp-amd64.json" \
  --shm-size 1g --stop-timeout 20 --env-file .env adapt-a11y-scanner assignment 5678
```

This scanner is one of three repositories that make up the Remedy stack:

| Repository | Role |
|---|---|
| `libretexts-remedy-server` | the engine — all checking and remediation behind `/v1/*` |
| `libretexts-remedy-bridge` | CXone Expert page I/O (not needed to scan ADAPT) |
| **`adapt-a11y-scanner`** | this repo — headless ADAPT rendering + scan |

**To deploy all three together, follow `deploy/stack/README.md` in the
`libretexts-remedy-server` repository.** That is the only compose file that
wires the full stack, and it is the recommended starting point.

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
| `SCAN_MODE` | `http` (POST DOM to remedy-server) or `in-process` (bundled remedy-core, **dev-only**) |
| `REMEDY_ENDPOINT` | remedy-server URL when `SCAN_MODE=http` |
| `REMEDY_API_KEY` | **Required for `http`** — remedy-server API key, sent as `X-API-Key` (must equal the server's `APP_API_KEY`) |
| `SCANNER_MAX_ACTIVE_JOBS` / `SCANNER_MAX_QUEUED_JOBS` | per-process HTTP admission limits (defaults `1` / `8`, finite positive integers) |
| `SCANNER_JOB_TIMEOUT_MS` | total admitted-job deadline, including queue wait (default `900000` ms) |
| `REMEDY_TIMEOUT_MS` | max wait for the synchronous remedy scan (default `240000`) |
| `CHROMIUM_NO_SANDBOX` | deliberate sandbox opt-out (`1` or `true`); leave unset for sandboxed non-root execution |
| `MATHJAX_TIMEOUT_MS` / `NAV_TIMEOUT_MS` | render/wait tuning |

### Two scan modes
- **`http`** (default, recommended, **production**): the bridge POSTs the
  rendered HTML to a running **remedy-server** (`POST /v1/validate/html`,
  authenticated with `X-API-Key`) and stays a small stateless renderer. Scales
  independently; no Remedy code bundled. The response mapping in
  `src/scanner.ts` targets the libretexts-remedy-server schema (`all_violations`,
  `overall_passed`).
- **`in-process`** (**dev-only**): imports `@libretexts/remedy-core` and scans
  in the same process. Not wired for production transfer — you must install/link
  that package yourself (it is not a published dependency).

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
named `token`. The bridge sets that cookie from `ADAPT_TOKEN` (or mints one via
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

## What this repo is — and what your team still owns

This is a **working, deployable bridge** and the integration spec — *not* a
turnkey product feature. It was extracted from a verified proof-of-concept
(see [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for the evidence and findings).

**Ready:** the auth mechanism, the MathJax-v2 wait, the iframe DOM capture, the
`/api/get-header-html/{id}` fast path, batch-by-assignment, JSON output + exit
codes, containerization.

**Your DevOps team owns** (documented, not faked):
- the production **service-account / token** issuance and rotation,
- **where it runs** (a queue worker? a job ADAPT triggers on question save? a
  nightly sweep?),
- **where findings go** (store + surface in the ADAPT author UI, or a report),
- **upstream rate-limiting and observability** for the LLM-backed Remedy calls,
- if you point `SCAN_MODE=http` at a **different** validator than
  libretexts-remedy-server (e.g. a raw axe/pa11y/lighthouse service), the
  **response mapping** in `src/scanner.ts` must be adjusted — it is wired for
  the libretexts-remedy-server `all_violations`/`overall_passed` schema.

## Requirements
- macOS or Linux with Node ≥ 20 (uses built-in `fetch`/`FormData`/`node:test`)
- A reachable ADAPT instance + a service-account token
- A running **remedy-server** with an API key (`SCAN_MODE=http`), or
  `@libretexts/remedy-core` installed (`SCAN_MODE=in-process`, dev-only)

## Tests
`npm test` builds and runs the unit suite (`node:test`, zero extra deps):
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
