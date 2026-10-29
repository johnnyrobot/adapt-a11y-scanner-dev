# LT-121 lifecycle validation — 2026-10-29

Ticket: https://linear.app/johnnyrobot/issue/LT-121

Chief policy (ticket comment, 2026-10-29): default one active HTTP job, eight
queued jobs, finite positive configuration, sequential questions, one 900000 ms
deadline including queue/auth/enumeration/render/readiness/validation/retries,
overload/shutdown 503 with Retry-After 5, five-second cleanup grace, shutdown
within 15 seconds, and actual owned process termination before capacity release.

## Implementation and scope

`JobLifetime` owns the absolute deadline and parent disconnect cancellation.
`ScanAdmission` owns per-process actual active capacity and bounded queued work.
Fetch attempts include response-body consumption and clean up timers/listeners;
retry sleeps share the deadline and abort signal. The renderer uses Playwright's
public BrowserServer process ownership, with loopback-only control and explicit
sandbox launch options. Close is idempotent, escalates to BrowserServer.kill()
after five seconds, and waits for process cleanup. Browser startup is bounded to
five seconds. The server stops admission/readiness immediately on SIGTERM/SIGINT,
cancels active/queued work and closes sockets after drainage (15-second hard
shutdown limit with unsuccessful exit if exceeded).

HTTP requires SCAN_MODE=http. Arbitrary dev-only in-process CLI package work
cannot be interrupted; that limitation is explicit in README. No child worker or
background-job protocol was added. Stack configuration is outside this repo:
stop grace must exceed 15 seconds, and synchronous proxy/client timeouts must
exceed the configured total deadline plus browser cleanup allowance.

LT-120 contract parsing, report severity and no_work behavior are retained.

## TDD evidence

Tests were written and run before the corresponding fixes. Representative
literal failure output:

```text
HTTP lifecycle limits are finite integers and deadlines fit Node timers
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
undefined !== 1

actual HTTP admission limits browser work and frees disconnected queued jobs
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
200 !== 503

shutdown during login is an explicit unsuccessful 503, not a deadline or question report
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
504 !== 503
```

These passed after configuration/admission/cancellation changes. Fixture issues
found during development (SPA follow-up missing assignment context, sandbox test
still intercepting launch instead of launchServer, missing launchServer debug
PID output) were corrected without weakening assertions: the SPA follow-up uses
an actual iframe and actual owned PIDs are observed through the OS process tree.

## Checks actually run

- `npm run typecheck`: pass.
- `DOTENV_CONFIG_PATH=/dev/null npm test`: 53/53 pass.
- `DOTENV_CONFIG_PATH=/dev/null npm run test:browser`: 34/34 pass (35.4 seconds).
- Targeted actual-browser forced-disconnect capacity check: pass; the combined
  suite also includes this case.
- Existing source-backed renderer/job/CLI/API no_work and malformed-contract
  cases pass. Sandbox tests observe launchServer/connect and actual Chromium
  process arguments; synthetic launch failure has no unsandboxed retry.

Lifecycle tests use only synthetic loopback ADAPT/Remedy providers and fake
credentials. They cover overload/queued disconnect, login navigation and fetch,
assignment enumeration, question navigation, SPA frame readiness, math readiness,
validation, retry sleep, queued deadline expiry, retry deadline, shutdown, shutdown during login, and active capacity during forced cleanup. OS process-tree observations prove browser descendants
exit; post-abort provider observations prove no later questions/validation or
retry requests. Forced cleanup SIGSTOPs only the owned fixture browser and proves
five-second escalation, stopped health/admission and shutdown under 15 seconds.

## Validation limits

Run on macOS with real Chromium. Native Linux namespace/seccomp evidence requires
the existing Linux CI job; it was not claimed locally. No live ADAPT, Remedy,
deployed stack, Docker/Compose or TestSprite run occurred. The parent must
integrate the capture PR's readiness helpers with JobLifetime.timeout/check and
run the required Standards/Spec/Correctness review gate before committing or
opening/merging this separate lifecycle PR. Nothing has been committed or pushed.

## Integrated checks

Integrated with the complete LT-118/119 capture changes, including strict response
identity and residual math checks. `npm run typecheck`,53 unit tests and58 actual
browser/job/CLI/API checks pass with zero failures/skips. Math-readiness disconnect
now loads the pinned real MathJax2.7.3 library with official configured-startup
blocking, rather than a fake queue. Owned process cleanup and no-late-call checks
remain. Pre-open/pre-merge reviews and Linux CI are still required before merge.
