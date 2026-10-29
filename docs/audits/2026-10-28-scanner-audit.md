# Scanner audit — 2026-10-28 (Pacific time)

Ticket: [LT-100](https://linear.app/johnnyrobot/issue/LT-100). Audited revision: [`d2b4491a56261b19f23493dc62958f50ce864b8d`](https://github.com/johnnyrobot/adapt-a11y-scanner-dev/commit/d2b4491a56261b19f23493dc62958f50ce864b8d), then `main`. The tracked tree was clean at audit entry. During that audit, only local artifacts were added; no commit, push, PR, paid review, deployment or live ADAPT/Remedy request occurred.

Archive scope: this report and the [proposed sandbox spec](../specs/2026-10-28-chromium-sandbox-default.md) preserve the findings and selected first slice. Application code, configuration and existing tests remain unchanged. Raw evidence, executable drafts, operational walkthroughs and the HTML preview remain local-only and are not included in this archive. All measurements and file:line references below describe the audited revision and its installed dependencies, not a new execution during archiving.

## Verdict

The scanner's small module structure is useful, but green helper tests do not establish trustworthy capture. Six major findings affect isolation, capture validity, fail-closed contracts or resource ownership. Correct the Chromium sandbox setting first as a small safety fix; make trustworthy rendering the first architecture slice. Preserve sequential assignment execution until real workload measurements justify concurrency.

This is an audit and candidate list, not approval to implement the proposals. No critical finding was confirmed. External WCAG accuracy, production throughput and container behavior remain unverified.

## Method and scope

Applied Matt Pocock **ask-matt → improve-codebase-architecture + codebase-design**. Read shared rules and all four shared agent documents, README, source, tests, deployment files and recent history. The architecture skill's read-only exploration subagent independently inspected module depth and reported evidence; this was a native exploration helper, not a named teammate review. Read diagnosing-bugs, tdd and to-spec to select subsequent work, without executing their implementation or publishing flows.

Recent runtime hotspots are renderer/server/client/job (`8bc8870`, `60ebc2c`, `6a95b8a`, `bbc8caa`). Prior changes improved navigation deadlines, assignment timeouts, severity normalization and status classification. This audit checked the behavior around those changes rather than recommending broad restructuring.

Used only synthetic HTML, fake tokens and local fixture endpoints. The real scanner's `AdaptRenderer`, `runAdaptScan`, HTTP listener and response parser were exercised. The downstream validator was a stub returning a passing verdict; this establishes scanner handling, not Remedy's WCAG accuracy. MathJax cases model queue state and delayed typesetting; they do not execute the real MathJax library. `DOTENV_CONFIG_PATH=/dev/null` in the harness prevents loading local credentials.

## Ranked findings

| Rank | Severity / confidence | Evidence | Impact | Effort |
|---|---|---|---|---|
| F1 | Major / high | `src/renderer.ts:53–56`; installed `node_modules/playwright-core/types/types.d.ts:15512` and `lib/coreBundle.js:41681–41682` | Claimed sandbox default is false in the actual launch options. Playwright adds `--no-sandbox` unless `chromiumSandbox === true`. Instructor-authored JavaScript gets weaker isolation than the source and Dockerfile promise. | Small correction; medium Linux/container proof |
| F2 | Major / high | `src/renderer.ts:127–138` | Navigation ignores response status and final identity. A synthetic 404 captured 119 bytes and the full job returned exit 0 with one scanned question. A 302 to `/login` captured the sign-in page. | Small–medium |
| F3 | Major / high | `src/renderer.ts:168–186`; `src/job.ts:40–49` | Readiness errors are swallowed. A permanently busy MathJax queue timed out at 100 ms and the full job still returned exit 0. An idle queue followed by typesetting at 1200 ms was captured raw around 548 ms: `(typeset || true)` accepts the idle gap. No degraded-readiness field reaches the gate. | Medium |
| F4 | Major / high | `src/adapt-client.ts:39–48`; `src/report.ts:36–40` | Unknown assignment JSON becomes `[]`, then exit 0 with scanned=0. Synthetic `{unexpected_schema:true}` reproduced this through the full job. A changed response contract can silently skip an entire assignment. | Small–medium |
| F5 | Major / high behavior; medium operational impact | `src/server.ts:28–73`; `src/job.ts:63–78`; `src/scanner.ts:43–74` | No admission limit, client-disconnect cancellation or total job deadline. Each HTTP job creates its own browser. Three requests reached validation simultaneously; after client abort, its job still issued one downstream validation. Resource exhaustion threshold was not tested. Retries also get a fresh timeout each attempt. | Medium–large |
| F6 | Major / high | `src/scanner.ts:124–127` | `{overall_passed:true, all_violations:"invalid"}` produces a passing result with zero findings. Missing/unrecognized collections are not fail-closed when the verdict is true. This is a contract-drift failure mode, not evidence of current server output. | Small |

### Proposed acceptance criteria

- **F1:** default launch explicitly enables the Chromium sandbox; the explicit opt-out remains visible and deliberate. Verify the actual launched arguments plus non-root Linux container behavior. A config-helper assertion alone cannot prove sandbox operation.
- **F2:** 401/403/404/500 and unexpected authentication redirects cannot yield a successful question scan or reach Remedy. Valid iframe and SPA fixtures still scan. Report actual final location and a useful failure reason; allow only deliberate redirect patterns.
- **F3:** busy, failed or interrupted typesetting cannot silently pass. Delayed startup, idle-before-typeset, no-math and successful typesetting get separate fixtures. Agree on the no-math/readiness policy with Chief before choosing checks; distinguish readiness timeout from accessibility findings.
- **F4:** reject unknown/non-array envelopes and malformed question entries. Distinguish a recognized empty assignment from an unrecognized schema. Chief chooses whether a genuinely empty assignment is success, failure or a separate no-work result.
- **F5:** agree on a maximum active-job count, bounded queue and overload status; verify the limit through simultaneous requests. An aborted caller or total deadline cancels waiting, navigation, fetch and retry sleep, and releases pages/contexts/browsers exactly once. Verify cancellation at each phase and during shutdown. Preserve current sequential per-assignment behavior unless measurements justify a change.
- **F6:** validate verdict type, collection presence/type and violation entries before accepting pass; malformed bodies fail closed with a contract error. Existing canonical severity and valid passing/warning/failing response behavior survives. Coordinate valid response examples with Remedy Server Dev through Chief.

## Lesser findings and hypotheses

- **Deterministic state, medium priority:** `src/renderer.ts:58` reuses one browser context across assignment pages. A synthetic page wrote localStorage and the next question read it. Whether real question scripts depend on or pollute this state is unverified. Decide which cookies/storage must persist before introducing isolation; do not blindly launch a browser per question.
- **Validation/status, minor:** `src/server.ts:101–114` accepts any string/number; `../bad` starts a job and returns HTTP 200 with failed=1. Question path traversal was blocked by the renderer in this test. Assignment IDs reach URL interpolation in `src/adapt-client.ts:25` without the numeric check. No exploit or live request was attempted. Validate all IDs before launching Chromium; assert invalid input is a cheap 4xx and never performs an authenticated fetch.
- **Large input policy, medium priority:** no explicit rendered-byte/assignment-count/output budget exists. All results are retained in memory and serialized at once (`src/job.ts:66–81`, `src/index.ts:40`, `src/server.ts:117–119`). The measured 1.05 MB question rendered successfully; memory ceilings and very large results were not measured. Measure representative synthetic shapes before adding streaming or truncation, and never silently truncate accessibility content.
- **Retry policy, minor:** `Retry-After` accepts delta seconds only (`src/scanner.ts:91–96`). Four attempts with 75 ms responses and 50 ms retry delays took 462 ms despite a 100 ms per-attempt limit. This is bounded per attempt, not one scan deadline. At defaults the configured upper budget can approach 4×240 s + 3×60 s = 1140 s per question before render costs (derived, not a measured production duration).
- **Diagnostics, minor:** failed scans lose already-captured URL/byte evidence because `scanOne` returns the initial base object (`src/job.ts:52–53`); close errors are swallowed (`src/renderer.ts:189–200`). Preserve useful stage diagnostics without logging credentials or private question bodies.
- **Captured DOM assets, hypothesis:** serialized HTML does not carry response headers, cookies, computed CSS or fetched assets. Relative resources may resolve differently at Remedy. Real server contract and MathJax/CSS behavior need a separate authorized integration check before claiming parity.

## Measurements and baseline checks

Evidence was recorded in a local-only synthetic baseline harness and JSON output; neither is a GitHub attachment or part of this archive. The harness bound synthetic dependencies and the scanner listener to IPv4 loopback, then closed both and terminated its child. It recorded observations, including expected defects; exit 0 meant the audit harness completed, not that its observed defects passed a regression gate.

| Check | Actual result |
|---|---|
| `npm run typecheck` with Node 24.12.0 | Pass; real 0.58 s |
| `npm test` (includes TypeScript build) with Node 24.12.0 | 43/43 pass; real 0.91 s; test duration 250 ms |
| Node 22.20.0, `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | Pass; real 0.54 s |
| Node 22.20.0, `node --test 'test/**/*.test.mjs'` | 43/43 pass; real 0.27 s |
| `npm ls --depth=0` | Playwright 1.60.0, TypeScript 5.9.3, dotenv 16.6.1, @types/node 22.19.19; no tree errors |
| `npm audit --omit=dev --json` | 0 reported vulnerabilities; not proof of complete security |
| `npx playwright install chromium` | Installed missing Chromium 1223 / Chrome Headless Shell 148.0.7778.96 into user cache; repo dependencies unchanged |
| Local-only synthetic baseline harness | Complete; iframe + SPA synthetic captures, contract failures, concurrency and disconnect evidence recorded |
| Lint | No lint script configured |
| Fresh `npm ci` / remote CI | Not run; checked installed lock versions; no clean-install or remote CI claim |
| Docker build / container runtime | Not run; daemon unavailable (error below, host-specific path replaced) |

Final measurement run: macOS arm64, Node 24.12.0, 2026-10-29T04:03:42Z (October 28 Pacific). Small no-math captures: **559, 549, 548 ms** (median 549 ms, n=3), largely consistent with `networkidle` overhead. The 25,000-paragraph question captured **1,050,094 bytes in 579 ms** (n=1). SPA iframe capture: **550 ms** (n=1). Warm browser init: **93 ms** (n=1); first run after installation had a 1533 ms cold init, illustrating why these are observations, not a capacity estimate. Three concurrent jobs completed in **1604 ms**, peak active synthetic validations=3. No CPU/RSS measurement or production throughput extrapolation was made.

Do not replace `networkidle` merely to remove ~500 ms until question readiness has an explicit observable contract. Under continuous background traffic it can also time out despite usable content; that scenario was not measured here.

Initial environment failure, before installing the matching browser (host-specific cache path replaced with `<user-cache>`):

```text
browserType.launch: Executable doesn't exist at <user-cache>/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell
```

Container preflight failure (host-specific home path replaced with `<user-home>`):

```text
failed to connect to the docker API at unix://<user-home>/.docker/run/docker.sock; check if the path is correct and if the daemon is running: dial unix <user-home>/.docker/run/docker.sock: connect: no such file or directory
```

The audited CI exercises compile + helper tests on Node 22 (`.github/workflows/ci.yml:18–25`), and never installs/runs Chromium. Rendering, job cleanup and HTTP lifecycle regressions therefore have no behavior coverage. Existing tests genuinely protect severity, auth headers, config and summary logic; retain them. Add synthetic behavior checks through the existing renderer/job/HTTP interfaces rather than tests of private methods. Docker's base tag matches locked Playwright, and the build installs matching Chromium, but sandbox behavior and supported Linux deployment were not validated. README's integration-document link points to a file removed in `7de803e`; this is a minor documentation defect, not permission to recover deleted material.

## Architecture candidates

1. **Strong — deepen trustworthy rendering.** Files: renderer/job/types. Put status, content identity, readiness, capture and diagnostics behind the rendering module's existing seam. The renderer already earns its depth: deleting it would scatter browser/auth/math knowledge across callers. Improve its guarantees instead of splitting it into many shallow helpers. Local synthetic documents provide a real second adapter to the network dependency for behavior tests. Locality: capture validity has one owner. Leverage: CLI and HTTP jobs inherit one guarantee. No new interface is chosen in this audit.
2. **Strong — deepen bounded job ownership.** Files: server/job/renderer/scanner. Concentrate admission, total deadline, cancellation and release in the job module. Its deletion would duplicate orchestration between CLI and HTTP callers. Test behavior through the job/HTTP seam. This is about resource ownership; a browser pool or parallel assignment scan is speculative until measured.
3. **Worth exploring — deepen strict transport contracts.** Files: adapt-client/scanner/report. Validate each external envelope in its existing module. Move generic JSON parsing out of the Remedy-specific module only if that reduces actual coupling. HTTP and in-process scan adapters are real variations, but no generic plugin or schema framework is justified. Deleting either adapter would move necessary mapping knowledge to callers; keep the earned depth.

## TestSprite — audit blocker and held proposals

Read both repo onboard/verify skills. Ran `testsprite --version` (0.15.0), authenticated `auth status`, `usage`, `project list --output json`, and CLI help for test listing, environments, creation and running. Account is Starter/V3 with run/read scopes. All five listed projects are unrelated to this repo; there is **no scanner project** and no local `.testsprite` project configuration. Therefore no relevant project tests/environments could be inspected; unrelated projects were not selected. An unscoped `test list --output json` returned the exact free local validation failure:

```text
Flag `--project` is invalid: is required; pass --project <id> or set TESTSPRITE_PROJECT_ID.
```

Balance before/after: **491.8 → 491.8 credits**, delta **0**. `usage --output json` reports **creditsPerRun=0.5**. No project/test was created, no plan generated, no tunnel opened, no run dispatched, and there are no scanner test IDs, run IDs, dashboards, run-specific artifacts or terminal TestSprite verdicts. Scanner product behavior remains unverified by TestSprite.

The CLI is a genuine backend target through `POST /v1/adapt/scan`; it has no browser UI. TestSprite's `--local` is frontend-only and cannot execute backend scripts against this loopback listener. Building a mock UI or testing the fixture pages would not verify the product. A public synthetic backend environment, authorized separately by Chief/Johnny, is the real prerequisite; this audit does not deploy one or bypass loopback restrictions.

Prepared three backend Python drafts, retained local-only. They were syntax checked, never uploaded or run. Any future execution requires a separately approved synthetic target and injected fake scanner authentication. No ADAPT or Remedy production token may reach TestSprite.

| Draft | Setup / assertions |
|---|---|
| `health_auth.py` | Scanner with fake key; GET `/healthz` is exactly `{ok:true}`; unauthenticated scan is 401 with `error=unauthorized`. No browser scan is triggered. |
| `question_success.py` | Real scanner pointed only at the synthetic question-1 fixture and passing validator stub. POST one question; require 200, ok=true, exitCode=0, scanned=1, failed=0, matching ID, nonempty captured bytes and a true validator verdict. |
| `capture_failure.py` | Synthetic question-404 fixture; require ok=false, nonzero exitCode, failed=1, scanned=0. This deliberately detects F2 and should fail on the audited revision. |

At the audit-observed 0.5 credit/run, three future runs were estimated at **1.5 credits**, or **2.0** including one retry. Project/script creation cost was not separately quoted. These historical estimates fit the initial 20-credit ceiling but are **not approval to create or run anything**. Future results would require run-specific IDs, terminal verdicts and inspected assertion/failure artifacts; none exist for this audit.

## Follow-up proposals and Chief decisions

At audit time, the LT search with repo label `adapt-a11y-scanner` returned only LT-100; no duplicate follow-up work was found and no follow-up issue was created during that phase. Subsequent planning selected F1 and created [LT-106](https://linear.app/johnnyrobot/issue/LT-106) and its implementation sub-issue [LT-107](https://linear.app/johnnyrobot/issue/LT-107). At archive preparation both remain Todo, and LT-100 remains Done. The [sandbox spec](../specs/2026-10-28-chromium-sandbox-default.md) records that proposed, unimplemented slice. Original ranked scopes:

1. **Restore explicit Chromium sandbox default** — F1; small first safety correction, with Linux launch evidence.
2. **Reject invalid/incomplete rendered questions** — F2/F3; first architecture slice; synthetic rendering behavior tests first.
3. **Fail closed on assignment and validator contract drift** — F4/F6; retain known valid envelopes; settle legitimate empty-assignment policy.
4. **Bound and cancel scanner jobs** — F5; Chief chooses limits/deadline/overload semantics before implementation.

Chief chooses candidates and the empty-assignment/readiness/resource policies. Use **tdd** at agreed renderer/job/HTTP seams for accepted fixes; use **diagnosing-bugs** if a real timing/performance issue resists the synthetic reproducer; use **to-spec** after decisions if bounded job ownership becomes a multi-session change. No interview with Johnny or speculative refactor is needed for this audit. Subsequent code/runbook changes require the full shared review gate; zero paid reviews ran here.

Cross-repo dependencies: Remedy Server Dev confirms actual validator envelopes, severity fields, asset resolution and deployment request limits; ADAPT owners confirm recognized assignment envelopes and a reliable question-ready signal; stack owners confirm worker limits, shutdown and sandbox prerequisites. These are recommendations for Chief to coordinate, not edits to teammate repos. Real ADAPT authentication, MathJax library timing, live WCAG scans, deployment reachability, Linux container isolation and cloud TestSprite execution remain unverified.
