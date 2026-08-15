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

Or as a container:

```bash
docker build -t adapt-a11y-scanner .
docker run --env-file .env adapt-a11y-scanner assignment 5678
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
server's network, or point `REMEDY_ENDPOINT` at its public Caddy endpoint). The
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
| `REMEDY_TIMEOUT_MS` | max wait for the synchronous remedy scan (default `240000`) |
| `CHROMIUM_NO_SANDBOX` | set `1` only when running as root; otherwise leave the sandbox on |
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

## How it authenticates
ADAPT's API guard is JWT (`tymon/jwt-auth`); the SPA reads the JWT from a cookie
named `token`. The bridge sets that cookie from `ADAPT_TOKEN` (or mints one via
`/api/login`). **In production, issue a dedicated service-account token** rather
than using a human password.

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
- **retries, rate-limiting, and observability** for the LLM-backed Remedy calls,
- if you point `SCAN_MODE=http` at a **different** validator than
  libretexts-remedy-server (e.g. a raw axe/pa11y/lighthouse service), the
  **response mapping** in `src/scanner.ts` must be adjusted — it is wired for
  the libretexts-remedy-server `all_violations`/`overall_passed` schema.

## Requirements
- Node ≥ 20 (uses built-in `fetch`/`FormData`/`node:test`)
- A reachable ADAPT instance + a service-account token
- A running **remedy-server** with an API key (`SCAN_MODE=http`), or
  `@libretexts/remedy-core` installed (`SCAN_MODE=in-process`, dev-only)

## Tests
`npm test` builds and runs the unit suite (`node:test`, zero extra deps):
response-mapping/severity (`scanner`), env validation (`config`), and the
fail-closed CI gate (`report`). CI runs typecheck + build + tests
(`.github/workflows/ci.yml`).
