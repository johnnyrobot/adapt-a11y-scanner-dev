# Bounded actual scan jobs (LT-121)

Ticket: https://linear.app/johnnyrobot/issue/LT-121

## Approved policy

Each HTTP process admits one active job and eight queued by default, with finite
positive integer configuration. Assignment questions remain sequential. One
900000 ms deadline begins at admission and includes queue wait, incoming request
parsing, startup, authentication/login, enumeration, navigation, math readiness,
validation, response bodies and retry delays. Lower phase limits are capped to
remaining time. Saturation/stopped admission returns 503 with Retry-After: 5 and
no browser or downstream activity; expiry returns 504. Both are unsuccessful.

Disconnect, expiry and SIGINT/SIGTERM abort waiting/active work. Shutdown stops
admission/readiness first and returns truthful 503 failures to connected callers.
Cooperative cleanup gets five seconds; total shutdown is at most 15 seconds,
with unsuccessful process exit if actual work cannot drain.

## Ownership and cancellation

JobLifetime owns the absolute deadline and cancellation. ScanAdmission owns
actual per-process capacity; it releases a slot only after job cleanup completes.
Fetch/body consumption and retry sleeps observe the same lifetime and remove
listeners/timers afterward. Rejected/expired partial uploads close their HTTP
connection instead of continuing to drain outside admitted capacity. Shutdown
uses a dedicated error type, independent of human-readable prose.

The renderer owns a private child process/group before awaiting startup. The
child hosts Playwright's loopback-only BrowserServer and publishes its endpoint
through private IPC. No endpoint is exposed through HTTP/error reports. The host
bounds launch AND connect, closes real browser work on cancellation, escalates
only its own process group after five seconds, and awaits actual worker reaping
AND group disappearance. A private temporary directory holds browser profiles;
it is removed only after the group exits. PID guessing and global process kills
are not used.

Locked Playwright 1.60.0's BrowserServerLauncherImpl passes no timeout argument to
ProgressController.run, so launchServer({timeout}) does not establish a deadline.
Its launchProcess normally detaches Chromium into a separate group. The private
worker therefore confines its spawn calls to the group already owned by the
parent. The override is confined to that worker and reviewed against installed
source; it does not affect the scanner's other children. Playwright's usual
negative-browser-PID kill fallback cannot kill this non-detached browser group;
the parent provides authoritative escalation. Recheck this dependency assumption
on Playwright upgrades. Tests assert actual browser PGID equals the worker PID.

Supported ownership platforms are macOS/Linux. Linux scanner PID1 execution is
refused: use a reaping init (`docker run --init`, Compose `init: true`) so orphaned
children do not remain zombies. The local Compose example uses init and 20-second
stop grace. The full-stack owner must carry these settings into its stack;
shipping-container and Compose proof remain separate release gates.

HTTP requires SCAN_MODE=http. The dev-only in-process CLI validator cannot
interrupt arbitrary external package code; that limitation is explicit. No
background-job protocol or child validator was introduced. LT-120 contracts and
no_work, LT-118/119 identity/readiness, sandboxing and networkidle are preserved.

## Executed verification

Local final checks: typecheck, 53 unit tests and 68 actual browser/job/CLI/API
checks passed, zero failures/skips. All providers are synthetic loopback
ADAPT/Remedy fixtures with fake credentials. No live instance, deployment,
container/Compose or TestSprite run is claimed. Native Linux namespace/seccomp
and final CI results are recorded in the PR before merge.

Coverage includes overload/queued disconnect, login navigation/fetch, assignment
enumeration, question navigation, SPA frame wait, real MathJax startup, validation,
retry sleep, queued expiry, retry deadline, partial successful login/enumeration/
validation response bodies, partial incoming upload expiry and shutdown.
Provider socket-close and post-abort observations establish no late calls; OS
process observations establish actual owned descendants exit before capacity is
reused. Forced SIGSTOP tests cover before/during actual launch, during connect,
actual API shutdown during startup/connect, and retained capacity during forced
cleanup. Sandbox variants and a real OS launch failure retain no-retry behavior.

Representative red evidence, followed by green checks:

```text
HTTP limits: undefined !== 1
Overload: 200 !== 503
Shutdown during login: 504 !== 503
Partial upload at a22c53d: connection 'keep-alive' !== 'close'
Old startup path: no owned worker before downstream login/startup wait
```

The first review found the real Playwright startup deadline blocker; the private
owner and stopped-process tests address it. Body-consumption evidence and typed
shutdown reasons address the two lesser review findings. The required fresh
Standards/Spec/Correctness gate and one external review are recorded in the PR.
Release parents LT-114/LT-111 stay open until all stack release gates pass.
