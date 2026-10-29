# Explicit Chromium sandbox default — first slice

Date: 2026-10-28 (Pacific). Source: [LT-100](https://linear.app/johnnyrobot/issue/LT-100), [audit finding F1](../audits/2026-10-28-scanner-audit.md#ranked-findings). Planning only; implementation had not started at archive preparation. Prepared with Matt Pocock **to-spec → to-tickets** from the Chief's selected scope and testing seam. This archive contains the proposed behavior and acceptance criteria; the original operational walkthrough remains local-only.

Tracker: [LT-106 spec](https://linear.app/johnnyrobot/issue/LT-106) → [LT-107 implementation](https://linear.app/johnnyrobot/issue/LT-107). At archive preparation both are Todo in Remedy and Conductor, labelled `adapt-a11y-scanner` and `ready-for-agent`; LT-107 is a sub-issue of LT-106 with no open blockers. Publishing this record does not implement or complete either ticket.

## Problem Statement

Operators are told that question JavaScript runs with Chromium's sandbox enabled by default. At the audited revision the renderer omits Playwright's sandbox option, whose default is false. Running the image as non-root does not itself turn the sandbox on. The promised isolation therefore differs from the browser that actually launches.

Evidence at [`d2b4491a56261b19f23493dc62958f50ce864b8d`](https://github.com/johnnyrobot/adapt-a11y-scanner-dev/commit/d2b4491a56261b19f23493dc62958f50ce864b8d): `src/renderer.ts:53–56`; installed Playwright 1.60.0 `types/types.d.ts:15512` and `lib/coreBundle.js:41681–41682`. The installed launcher appends `--no-sandbox` unless `chromiumSandbox` is exactly true. Audited tests check configuration parsing and pure renderer helpers, not a real launch.

## Solution

Explicitly enable Chromium's sandbox for ordinary scanner launches. Preserve the deliberate `CHROMIUM_NO_SANDBOX` opt-out and its existing accepted values, `1` and `true`. Unsupported sandbox environments must fail visibly rather than trigger an automatic unsandboxed retry. Demonstrate the default using the actual scanner renderer on a supported, non-root Linux runtime.

## User Stories

1. As an operator, I want the default launch to enable Chromium's sandbox so instructor-authored JavaScript receives the documented isolation.
2. As an operator, I want non-root execution and host prerequisites documented so I can run the default safely.
3. As an operator of a constrained environment, I want the existing explicit opt-out retained so I can make a deliberate exception.
4. As an operator, I want sandbox startup failures propagated so an unavailable security feature cannot silently become an insecure success.
5. As a maintainer, I want evidence from the launched process so helper tests cannot hide a Playwright default mismatch.
6. As a maintainer, I want a non-root Linux regression check in CI so a Mac-only pass cannot close this issue.
7. As a reviewer, I want the ordinary renderer to capture a synthetic question in that same browser so the security correction has a usable rendering path.

## Implementation Decisions

- Keep the existing renderer as the production seam; no new browser factory, public injection API, diagnostic endpoint or module split is needed for this slice.
- Supply Playwright's `chromiumSandbox` explicitly: true when the opt-out is false, false when the opt-out is true. Preserve existing configuration semantics; do not infer an opt-out from UID, CI, OS, missing namespaces or launch failure.
- Keep deliberate unsandboxed launch behavior visible in configuration and documentation. Default launches must have no disabling sandbox flags; the opt-out may retain the existing explicit argument.
- Preserve navigation, `networkidle`, MathJax waiting, authentication, capture/report formats and sequential assignment execution. The 549 ms synthetic render measurement does not justify a readiness change here.
- Extend the existing GitHub Actions workflow with a separate sandbox verification job pinned to Ubuntu 22.04 x64 and Node 22. The installed Playwright 1.60.0 platform detector explicitly supports Ubuntu 22.04; this also matches the image's Jammy base. Keep ordinary helper checks available without a browser install.
- Document container prerequisites alongside the default: non-root `pwuser`, matching browser/image version and a host policy permitting Chromium's namespaces and seccomp sandbox. Changing a teammate's stack is outside this ticket.

## Testing Decisions

- Use **tdd** for implementation: first demonstrate that the new real-launch default assertion fails on the audited revision, then correct the launch and make it pass. Keep the existing configuration/helper tests.
- Primary seam: real `AdaptRenderer.init → renderQuestion → close` with a loopback fixture and a fake JWT. Observe the launch through test-only instrumentation that delegates to the real launcher and retains its real browser handle; never replace Chromium with a fake. Restore observers and release browser/server resources in `finally` blocks.
- Check the passed sandbox option and independently inspect actual browser arguments through Chromium's browser protocol or the launched process command line. The default must omit `--no-sandbox` and other switches disabling renderer namespace/seccomp isolation. Check the deliberate opt-out separately for both accepted environment values; unset, `0`, and `false` must stay sandboxed.
- On Linux, record browser/renderer process identity and sandbox evidence while a synthetic page is alive. Require non-root browser UID, renderer seccomp filtering (`Seccomp: 2`), `NoNewPrivs: 1`, and renderer PID/user namespace isolation relative to the browser/Node process. Collect namespace links and namespace PID fields from `/proc`; a narrowly scoped, read-only CI inspector may use sudo if non-root inspection is denied. The browser and scanner themselves must remain non-root. On the native CI host, distinguish renderer filtering from the parent baseline; inherited container filtering alone is not proof.
- Capture a known no-math fixture through the renderer and assert its expected marker appears in the HTML; verify closure. For launch failure, verify rejection and no fallback attempt. Do not expand this into readiness, HTTP contract or cancellation fixes.
- The required Linux job must fail for missing Chromium, root UID, unavailable namespaces, failed launch, unreadable required evidence or a failed assertion. No skip/continue-on-error, sandbox disabling, privileged container, `seccomp=unconfined`, `SYS_ADMIN`, global AppArmor changes or kernel-policy relaxation to make it green.

## Out of Scope

The original planning task performed no application changes, PRs, commits, pushes, deployment or paid reviews. This later archive publishes documentation only. Live ADAPT/Remedy traffic, production credentials, TestSprite creation/runs, a new frontend, public synthetic deployment and tunnels remain outside the slice. Capture/status/identity/readiness, assignment/validator contracts, resource ownership and assignment concurrency are separate follow-ups.

## Further Notes

One proposed implementation slice, with no open ticket blockers: explicit default + retained opt-out + real browser/Linux proof + accurate runtime documentation. The spec and implementation sub-issue already exist as LT-106/LT-107; no duplicate planning is needed. Both remain Todo at archive preparation; LT-100 remains Done. Later proposals stay ranked only: trustworthy capture/readiness, fail-closed transport contracts, then bounded/cancellable job ownership.

## Proposed Linux verification evidence

No Linux verification has been executed for this slice. The proposed dedicated native Ubuntu 22.04 x64 / Node 22 CI job must exercise the real renderer with the locked Playwright/Chromium pair, non-root UID and working user/PID namespaces. Acceptance requires the actual launch arguments, renderer namespace/seccomp evidence, a successful synthetic capture and cleanup, and a default-launch regression that fails on the audited revision and passes after implementation. Missing prerequisites or required evidence must fail the job. No sandbox-disabling fallback or host-policy relaxation is acceptable.

Completion evidence must include the CI job/run URL, OS/Node/Playwright/Chromium versions, UID, actual arguments, namespace/seccomp observations and synthetic assertion results. The proposed integration harness does not yet exist. The original command walkthrough is retained locally and is not part of this documentation archive.

The shipping container remains a separate verification dimension: a native Linux job would not establish the Docker image's runtime isolation. Container validation would require the shipping image running as non-root with an audited namespace-capable seccomp policy, plus image identity and the same capture/isolation evidence. Until exercised, container runtime behavior remains an explicit deployment gap; a missing daemon is not a passing result.

Primary guidance consulted during planning on 2026-10-28: [Playwright CI installation and launch diagnostics](https://playwright.dev/docs/ci#github-actions), [Playwright non-root Docker sandbox requirements](https://playwright.dev/docs/docker#crawling-and-scraping). Those website examples used a newer Playwright image; the proposal retains this repo's locked 1.60.0 pairing. Runtime option/default and Ubuntu support were checked against the installed package during planning.

## Held TestSprite environment and budget

The audit's three local-only backend drafts cover health/auth, a successful synthetic question and rejected 404 capture. No scanner project/environment existed at audit time. Future execution requires a separately authorized HTTPS synthetic host running the real scanner, matching non-root sandbox-capable Chromium, fake scanner authentication, and internal synthetic ADAPT/validator dependencies. TestSprite's backend mode cannot target the loopback listener through frontend-only local mode. No production tokens or private question content may be supplied.

The passing validator stub would establish scanner handling only, not Remedy WCAG accuracy. The rejected-404 draft is expected to remain red after this sandbox-only slice until later capture-validity work lands.

The audit-observed price was 0.5 credit/run: three runs were estimated at **1.5 credits**, or 2.0 with one retry; creation/generation cost was not quoted. Usage/pricing and authorization must be rechecked before future dispatch. No project, test, environment or tunnel was created; no TestSprite run or paid review occurred for this spec. All creation/runs remain held.

## Verification of this planning task

During the original planning task, inspected the audit, local baseline JSON/harness, renderer/configuration/tests, Dockerfile and existing CI. Reran `npm run typecheck` and `npm test`: pass, 43/43 tests, zero failures/skips; the latter includes build and the existing CI test command. These are macOS checks, not sandbox proof. No source/configuration/test changes were made. Linux launch, container runtime and TestSprite execution remain unverified.
