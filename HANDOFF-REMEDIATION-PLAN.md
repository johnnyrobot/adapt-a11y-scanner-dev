# adapt-a11y-scanner — Production Handoff & Cross-Repo Remediation Plan

Scope: the three repos transferring from `github.com/johnnylibretexts/*` to the LibreTexts org:
- **SCANNER** `/Users/libretexts/code/adapt-a11y-scanner` (TS, the production http-path repo)
- **SERVER** `/Users/libretexts/code/libretexts-remedy-server` (Python FastAPI, `johnnylibretexts/libre-remedy-server`)
- **BRIDGE** `/Users/libretexts/code/libretexts_remedy-bridge` (TS monorepo, `johnnylibretexts/libretexts-remedy@aikido-refactor`, owns `@libretexts/remedy-core`)

This plan **builds on** the single-repo review in `CODE-HEALTH-REVIEW.md` (referenced by ID: B1/H1/H2/H3/M1–M7/L*) and merges it with the cross-repo seam findings. Every claim below was re-verified against the live code (file:line on both sides of each seam).

---

## 1. Answer: can the org put this into production as-is?

**No — not yet. It is fundamentally broken on the production (http) path and must not be deployed until the two cross-repo contract breaks, the Docker blocker, and the fail-open gate are fixed.** Verified end-to-end: against a real production server the scanner gets **401 on every POST** (it sends `Authorization: Bearer` at `scanner.ts:38`; the server only checks `X-API-Key` at `auth.py:19-26`, and production *forces* a key via `config.py:128-130`). Even against an open/unsecured server returning HTTP 200, the scanner reads `body.findings ?? body.results ?? body.issues` (`scanner.ts:48`) — none of which the server emits (real findings are under `all_violations`, `html_utils.py:70`) — so it parses **0 findings, exits 0, and silently passes every question** (a confirmed fail-open gate, H1/M4). On top of that the production container **cannot start** (Dockerfile base `playwright:v1.48.0-jammy` vs the lockfile's resolved Chromium for `playwright@1.60.0`, B1). In its current state the scanner is a green-checkmark generator that reports nothing; shipping it would give the org false accessibility assurance.

---

## 2. Must-fix before any production use (ordered)

### MF-1 — http response contract: parse `all_violations` + map `impact`→severity (Blocker; M4/H1)
**What's wrong.** `scanner.ts:48` extracts findings from keys that do not exist on this server. Verified server contract (`html_utils.py:61-71`): top-level keys are `axe`, `pa11y`, `lighthouse`, `wave`, `overall_passed`, `summary`, `all_violations`. The merged, deduped, severity-sorted flat list is `all_violations`. Each item's identifier is `id`, its severity is `impact` ∈ `critical|serious|moderate|minor` (`validator.py:484` axe, `:553` pa11y, `:663` lighthouse), provenance is `tool`, snippet is `context` (pa11y) or `html_snippets[0]` (axe), `wcag` is a **string** (comma-joined for axe per `_extract_wcag_tags` `validator.py:1430-1433`; single SC for pa11y). There is **no** `findings`/`results`/`issues`/`ruleId`/`rule`/`code`/`severity`/`snippet`/`source`/`fixable` key anywhere in the response.

**Files.** SCANNER `src/scanner.ts:34-66` (scanHttp + normalize) ; SERVER `backend/app/html_utils.py:61-71`, `src/project_remedy/validator.py:482-495/551-562/660-667`.

**Concrete change.** Read `all_violations`, surface the authoritative `overall_passed` up to the gate, and branch the field map across tool shapes:

```ts
// scanHttp — return findings AND the server's verdict (do not discard it)
async function scanHttp(html: string, cfg: Config): Promise<{ findings: Finding[]; overallPassed: boolean }> {
  // ...build form...
  const body = await res.json();
  const raw = Array.isArray(body.all_violations) ? body.all_violations : [];
  return { findings: normalize(raw), overallPassed: body.overall_passed === true };
}

function mapImpact(impact: unknown): 'error' | 'warning' {
  // server's own pass/fail = fail iff any critical|serious (validator.py:245-250)
  return impact === 'critical' || impact === 'serious' ? 'error' : 'warning';
}

function normalize(items: unknown[]): Finding[] {
  return items.map((f) => {
    const o = f as Record<string, unknown>;
    return {
      ruleId: String(o.id ?? 'unknown'),                       // server uses `id` for every tool
      wcag: o.wcag ? String(o.wcag) : undefined,               // string (axe comma-list | pa11y single SC)
      severity: mapImpact(o.impact),                           // critical|serious->error, moderate|minor->warning
      message: String(o.description ?? o.help ?? ''),          // server uses `description`
      selector: o.selector ? String(o.selector) : undefined,   // pa11y only
      snippet: o.context
        ? String(o.context)                                    // pa11y
        : (Array.isArray(o.html_snippets) && o.html_snippets.length
            ? String(o.html_snippets[0]) : undefined),         // axe (first of up to 3, pre-truncated)
      fixable: undefined,                                       // not emitted on /v1/validate/html — see MF-note
      source: o.tool ? String(o.tool) : undefined,             // provenance: axe|pa11y|lighthouse|wave
    };
  });
}
```
Lighthouse/wave legitimately carry only `id`/`impact`/`description`/`tool`; leave their `wcag`/`selector`/`snippet` undefined (do not coerce). `fixable` has **no source** on this endpoint (validate-only path runs `validator.validate`, not remediation, `validate_routes.py:86`); leave it undefined and document it.

### MF-2 — fail-closed gate (Blocker companion to MF-1; H1/H2)
**What's wrong.** `index.ts:41` counts `findings.filter(f => f.severity === 'error')` and `index.ts:78` exits `totals.errors > 0 ? 1 : 0`. Before MF-1 this is always 0. After MF-1 it works for findings, but (a) it still ignores the authoritative `overall_passed`, and (b) a per-question hard failure (401/429/timeout/render error) is caught at `index.ts:44-46` and recorded with `stats.errors:0`, so a **fully failed run still exits 0** (H2 fail-open).

**Files.** SCANNER `src/index.ts:38-46,73-78`.

**Concrete change.** Have `scanOne` consume `{findings, overallPassed}` from MF-1, record `overallPassed` and a boolean `failed` on each result, and at the bottom exit non-zero if **any** question has `overallPassed === false`, real errors, **or** an `error` field set. Treat missing/non-true `overall_passed` as failure (fail-closed). This single change defeats M4's silent-pass, H1's severity-gate miss, and H2's swallowed per-question failures simultaneously.

### MF-3 — auth transport: send `X-API-Key`, drop the dead Bearer (Blocker; cross-repo)
**What's wrong.** `scanner.ts:37-38` sets only `Authorization: Bearer <remedyToken>`. A grep of the entire server backend for `authorization`/`bearer` returns nothing — the Bearer header is a **no-op**. The `/html` route is guarded by `dependencies=[require_key]` (`validate_routes.py:73`, `require_key` built at `:66`); the dependency reads only `x_api_key: str | None = Header(...)` and `compare_digest(x_api_key or "", settings.api_key)` → 401 (`auth.py:19-26`). Production forces a non-empty key: `if self.is_production and not self.api_key.strip(): errors.append(...)` (`config.py:128-130`). So a production server **always 401s** the scanner. SCANNER has no env that maps to `X-API-Key`.

**Files.** SCANNER `src/config.ts:32-33,53-54,60-62`, `src/scanner.ts:37-38`, `.env.example:33-34`, `README.md` (config table) ; SERVER `backend/app/auth.py:19-26`, `backend/app/config.py:128-130,148`.

**Concrete change.**
1. `config.ts` — add to the `Config` interface `remedyApiKey?: string;` and in `loadConfig()` `remedyApiKey: process.env.REMEDY_API_KEY || undefined,`; extend the http guard at `config.ts:60-62` to also fail fast when `scanMode==='http' && !remedyApiKey`.
2. `scanner.ts:37-38` →
   ```ts
   const headers: Record<string, string> = {};
   if (cfg.remedyApiKey) headers['X-API-Key'] = cfg.remedyApiKey;
   ```
3. Remove `remedyToken`/`REMEDY_TOKEN`/Authorization entirely — dead config that misleads operators.
4. `.env.example` — replace the commented `# REMEDY_TOKEN=` (line 34) with `REMEDY_API_KEY=` and note it must equal the server's `APP_API_KEY` (`config.py:148`). Add a `REMEDY_API_KEY` row to the README config table.

### MF-4 — Docker image cannot launch Chromium (Blocker; B1)
**What's wrong.** `Dockerfile:3` pins `mcr.microsoft.com/playwright:v1.48.0-jammy`, but `package-lock.json`/`node_modules` resolve **playwright 1.60.0** (verified `require('playwright/package.json').version === 1.60.0`). The 1.48 base ships the Chromium build for 1.48; 1.60's launcher looks for a different revision and there is no `npx playwright install`, so `chromium.launch()` fails at runtime in the container.

**Files.** SCANNER `Dockerfile:3,8-14`, `package.json:17` (`playwright ^1.48.0`), `package-lock.json`.

**Concrete change.** Pin the base image to the exact locked Playwright version (`FROM mcr.microsoft.com/playwright:v1.60.0-jammy`) **or** pin `playwright` to `1.48.x` and regenerate the lockfile — the base image tag and the locked package version must match. Add `RUN npx playwright install --with-deps chromium` after `npm ci` as a belt-and-suspenders. Also fix the non-deterministic install (`Dockerfile:9` `npm ci ... || npm install`, L7) to plain `npm ci` once MF-9 settles the lockfile.

### MF-5 — fetch timeout against the synchronous validate endpoint (High; M1/M2)
**What's wrong.** `scanner.ts:40` passes no `signal`/timeout. `/v1/validate/html` is fully synchronous and heavy — it runs axe + pa11y + Lighthouse inline before responding (`validate_routes.py:86,92`); on a MathJax-heavy page this is tens of seconds with no server-side request cap. A stalled connection hangs the whole assignment loop forever (`index.ts:65`).

**Concrete change.** Add an M2-validated `remedyTimeoutMs` env (reject `NaN`/`0`), default **~240000 ms** (above the 90–180 s worst case, around undici's 300 s headers timeout), and pass `signal: AbortSignal.timeout(cfg.remedyTimeoutMs)` to `fetch`. The rejection is a `DOMException` with `name === 'TimeoutError'`; catch it and re-throw a descriptive `Error` so MF-2 records it as a per-question failure (not a silent pass).

### MF-6 — 429 rate-limit handling (High; H2)
**What's wrong.** The loop fires one POST per question with no pacing (`index.ts:65`). The `/html` route carries `@upload_limit` (`validate_routes.py:74`), default `RATE_LIMIT_UPLOADS=10/minute` keyed per client IP (`main.py:100-109`), `headers_enabled=True` so 429s carry `Retry-After`. Any assignment >10 questions/min from one IP (or several scanners behind one NAT) starts getting 429 on the 11th POST; `scanner.ts:41-42` throws, `index.ts:44-46` swallows it, run still exits 0.

**Concrete change.** In `scanHttp`, special-case `res.status === 429`: read `Retry-After`/`x-ratelimit-reset`, sleep, retry with bounded exponential backoff; a final 429 must propagate into MF-2's fail-closed path. The loop is already sequential — do **not** add a concurrency limiter. DevOps option: key the server limiter by API key (clean once MF-3 lands) or raise the limit / allowlist the scanner's egress IP. (`storage_uri=memory://` + `--workers 1` means the bucket is already coherent.)

### MF-7 — correlate failures with the server's `x-request-id` (Medium; M4)
`scanner.ts:42` builds the error from status + body only. The server stamps `x-request-id` on every response (`main.py:130-131,151`) and embeds `request_id` in 5xx bodies. Capture it: `const rid = res.headers.get('x-request-id'); throw new Error(\`remedy-server ${res.status}${rid ? ' [request_id='+rid+']' : ''}: ${(await res.text()).slice(0,300)}\`);`. Optionally also send `x-request-id` as a request header.

### MF-8 — default endpoint/topology that actually resolves and authenticates (Medium; cross-repo)
`.env.example:32` ships `REMEDY_ENDPOINT=http://remedy-server:8000/v1/validate/html`, a container-DNS name on a port the server only `expose`s on its internal `edge` bridge (no host `ports:`; only Caddy reaches `:8000`). The scanner ships no compose/k8s of its own, so nothing joins it to `edge`. Pick and document a supported topology: (a) ship a scanner compose service on the server's `edge` network (keep the internal DNS name), **or** (b) default to the public Caddy endpoint `https://<DOMAIN>/v1/validate/html` (443). Either way MF-3's `X-API-Key` is mandatory. Also note in the scanner README: the server's `runtime-slim` image **disables** `/v1/validate/html` (503) and must not be deployed with the scanner — only the full `runtime` image works.

### MF-9 — minimal CI + smoke tests on the production-path repo (Medium; H1)
SCANNER has **zero** `.github/` and **zero** tests (verified: `git ls-files` shows no `.github/`, no test/spec files). The repo that owns the fail-open gate and the broken Docker image has no automated verification. Add `.github/workflows/ci.yml` running `npm ci && npm run typecheck && npm run build`, plus (a) a unit test feeding a realistic `all_violations` payload through `normalize()` asserting `errors > 0`, and (b) a test of the MF-2 exit gate. Without this, MF-1/MF-2 will silently regress in the org.

> **Note (fixable):** `/v1/validate/html` does not return fixability (it runs detection only, `validate_routes.py:86`). Document in `docs/INTEGRATION.md` that `fixable` is always undefined on this endpoint; do not fabricate it.

---

## 3. In-process mode & the `.mjs` drivers — RETIRE from the prod repo

**Recommendation: retire in-process mode and both driver scripts from the SCANNER handoff repo.** Production is http; in-process adds only liabilities at transfer:

- `@libretexts/remedy-core` is `"private": true`, version `0.0.1`, **never published** (verified in `packages/core/package.json`). SCANNER declares it `optionalDependencies "@libretexts/remedy-core": "*"` — a wildcard that resolves to nothing from any registry. Today it works **only** via an uncommitted, dangling symlink `node_modules/@libretexts/remedy-core -> ../../../libretexts-remedy/packages/core`, whose target name (`libretexts-remedy`) no longer matches the real dir (`libretexts_remedy-bridge`). On a fresh org clone it does not exist.
- `fix-question.mjs` and `demo-chart-fix.mjs` are git-tracked (verified). `fix-question.mjs:15` hardcodes the pre-rename sibling path and reads the bridge's `.env`; both import the unpublished core and `fix-question.mjs` needs a manually-started static mirror. They are inert dev/demo tools in a repo being handed off for production.
- The API *shapes* are aligned (`core.scanHtmlFull(html)`, `runLocalPipeline`, `LocalPipelineResult`, `StrategyReport.strategyId`), so this is purely a packaging/transfer problem, not a code-contract problem.

**Action.** Delete `fix-question.mjs` and `demo-chart-fix.mjs` from SCANNER and relocate them into BRIDGE (which natively owns `@libretexts/remedy-core` and the OpenRouter `.env`). Keep `scanInProcess` only if explicitly wanted as a dev-only mode; if kept, document it as dev-only and wire it via an npm workspace / `file:` dependency to `libretexts_remedy-bridge/packages/core` (never a hand-made symlink), and replace the `"*"` range. The http production path is unaffected by removing all of this (the optional dep is skipped gracefully by `npm ci`; `scanner.ts:25-29` already throws a clear error if in-process is selected without the package).

---

## 4. Transfer hygiene — per-repo checklist before pushing to the org

**Secret exposure — PASS (verified).** All three repos track only `.env.example` (live `.env` files exist locally but are gitignored). No tracked secret JSON/PEM. Belt-and-suspenders before transfer: `git -C <repo> log --all --full-history -- .env '.env.*' '*.env'` (use `--all` for BRIDGE's `aikido-refactor` branch) — already run, zero history hits. Enable org-level GitHub secret scanning + push protection after transfer.

**SCANNER**
- Regenerate `package-lock.json`: root identity is stale `name: "adapt-remedy-bridge"`, `bin: "adapt-remedy"` (verified) vs `package.json` `adapt-a11y-scanner` (L8). Run `npm install`, commit, then standardize CI on `npm ci`.
- Add `.dockerignore` (L9); add `.github/workflows/ci.yml` (MF-9).
- Delete the two `.mjs` drivers (§3).
- LICENSE already reads `Copyright (c) 2026 LibreTexts` — no change. Internally consistent naming (dir = remote = package = `adapt-a11y-scanner`); only the org transfer itself is needed.

**SERVER**
- Working tree is dirty: 10 modified-but-uncommitted tracked files incl. `validator.py`, `pyproject.toml`, `uv.lock` (the defusedxml XXE/XML-bomb hardening). **Commit** (do not discard) before pushing — a plain push moves only HEAD. `pyproject.toml` and `uv.lock` are already in sync.
- Untrack internal dev artifacts: `BUILD_LOG.md` and `v2_docs/*` (incl. `session-memory-2026-05-12.md:22-23`, which embeds `/Users/johnnyrobot/Desktop/...` personal paths). `.gitignore` ignores them at lines 33-35 but **re-includes** via negations at 102-103 / 116-119 — delete those negation lines AND `git rm --cached BUILD_LOG.md && git rm -r --cached v2_docs/`, then commit.
- LICENSE holder is `Copyright (c) 2026 Johnny Phung` (verified) — reconcile to the org holder, but as a transfer-agreement/CLA decision with the author, not a unilateral edit.
- README `git clone` URL (`README.md:72`) points at `github.com/johnnyrobot/remedy-server` — wrong account AND wrong repo name (real remote `libre-remedy-server`). Fix to the final org slug; keep `cd remedy-server` consistent (lines 73/102/107 depend on the dir name) or update all of them.

**BRIDGE**
- Add a top-level `LICENSE` (MIT text, `Copyright (c) 2026 LibreTexts`) — `package.json` declares MIT but no license file is tracked (verified).
- Add `.github/workflows/ci.yml` running `npm ci && npm run build && npm test` — 25 vitest tests are tracked but nothing runs them.
- Optionally `git rm --cached .claude/settings.json` (harmless shared config; leaving it is also fine).
- Merge `aikido-refactor` into the default branch so the in-process source is stable; reconcile dir name `libretexts_remedy-bridge` vs remote/package `libretexts-remedy`.

**All three** — pick canonical org repo names, update `pyproject.toml`/`package.json` names and README clone URLs to the final org slugs after transfer.

---

## 5. What the org must still build (DevOps-owned)

The scanner today only prints findings JSON to stdout and exits (`index.ts:77`); the synchronous server path persists nothing (`validate_routes.py` stages, validates, returns, `path.unlink`). None of the following exist in any of the three repos and are required for a real deployment:

1. **Trigger** — where it runs: on-save job, queue worker, or nightly assignment sweep (no scheduler/webhook/cron/k8s tracked).
2. **Findings sink** — where results go: a datastore + surfacing in the ADAPT author UI. Persistence belongs on the **caller/scanner** side, *not* by wiring the synchronous server endpoint into `jobs.db` (its non-persistence is correct-by-design).
3. **Service-account token issuance + rotation** — for `ADAPT_TOKEN` (overlaps H3: the JWT is currently set as a non-httpOnly/non-secure cookie, `renderer.ts:34-36`) and the `REMEDY_API_KEY`.
4. **Transport hardening** — enforce HTTPS on `ADAPT_BASE_URL` and the remedy endpoint (H3, MF-8).
5. **Observability + retries/rate-limit budget** — log correlation via `x-request-id` (MF-7), backoff (MF-6), and a per-scanner rate-limit allowance.
6. **A reference deployment** — a scanner compose service or k8s CronJob joined to the server topology (MF-8), running the full `runtime` server image.
7. **Container hardening** — run as non-root (M7) and review `--no-sandbox` (M6).

---

## 6. Suggested sequencing

1. **Contract fixes (unblock the path):** MF-1 (parse `all_violations` + impact map) → MF-3 (`X-API-Key`) → MF-8 (resolvable, authenticated endpoint/topology). Nothing else matters until findings flow and auth passes.
2. **Fail-closed gate:** MF-2 (gate on `overall_passed` + treat per-question errors/timeouts/429 as failures). This is what converts the tool from fail-open to trustworthy.
3. **Hardening:** MF-5 (timeout) → MF-6 (429 backoff) → MF-7 (request-id) → H3/M6/M7 transport & container hardening.
4. **Packaging:** MF-4 (Docker base ↔ Playwright version + `playwright install`) → MF-9 (CI + smoke tests) → §4 hygiene (lockfile regen, `.dockerignore`, dirty-tree commit on SERVER, artifact untracking, BRIDGE LICENSE/CI) → retire in-process/`.mjs` (§3).
5. **Transfer:** finalize canonical org names, fix README clone URLs/`pyproject`/`package.json`, enable org secret scanning + push protection, then transfer all three repos.
6. **Org-build (post-transfer):** §5 — trigger, findings sink, token rotation, observability, reference deployment.

**Bottom line:** production-incorporable **only after** the four blockers (MF-1, MF-2, MF-3, MF-4) land with a regression test; everything in §3–§5 is required for a maintainable, deployable handoff but not for first correctness.
