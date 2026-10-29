# Trustworthy question capture (LT-118 / LT-119)

Approved seams: actual renderer → job, with synthetic loopback ADAPT/Remedy
providers. LT-111/LT-114 remain release gates; this change does not certify a
live ADAPT instance or a shipping container.

## Document contract

Only successful HTML responses at the exact configured origin and exact requested
question route are eligible for validation: `/api/get-header-html/{questionId}`
or SPA `/assignments/{assignmentId}/questions/view/{questionId}` plus its content
frame at the former route. Query/fragment changes and different IDs/origins fail.
Same-final-route redirects are accepted only if the final response is successful
HTML. No login or alternative-route allowlist is inferred. Password forms in the outer SPA document or content
question route fail. An arbitrary HTTP-200 HTML body cannot be identified as an
application error without an ADAPT content contract; identity is not inferred
from body size or prose. Unknown frames cannot become the selected question.

Check outer navigation and content response status and response URL as well as
the current browser URL (history manipulation cannot disguise a redirected response), then recheck both identities
before capture. Failures return unsuccessful job results with zero scanned
questions and no validator call. Diagnostics contain stage, HTTP status and safe
origin/path, omit query/fragment/URL credentials and unknown paths, and never quote
question source or browser exception text. Navigation/readiness interruption is
an operational failure, distinct from accessibility findings.

## Readiness contract

Retain navigation `networkidle` and completed content-document readiness. A true
no-math/no-library document is valid. Native MathML, math source scripts, rendered
MathJax nodes, standard TeX delimiters (`\(`, `\[`, `$$`), a MathJax loader or
configuration, or a MathJax global requires supported completion. Unknown majors
fail explicitly. No fixed sleep or temporary queue-idle signal establishes ready.

For v2, observe the official replayable startup `End` hook, then queue a fresh
`Typeset` of the content body and a completion callback. Inspect all resulting jax
for actual rendered output, reject residual native MathML/unprocessed source
scripts, residual TeX delimiters and error output. Saved CommonHTML markers also
require a supported library/completion; they are not classified as no-math. Retained Ajax load-error statuses and Hub processing errors are checked before
and after Typeset; signal observation also handles current errors. This retains
failures even when startup clears signal history. File-load/processing errors, blocked queues, missing
libraries, timeouts and interrupted documents fail before validation. Declared
libraries on no-math questions must still finish startup and the queued Typeset.

MathJax APIs: [startup sequence](https://docs.mathjax.org/en/v2.7/advanced/startup.html),
[queued typesetting](https://docs.mathjax.org/en/v2.7/typeset.html). The installed
unpacked 2.7.3 sources independently confirm replayable StartupHook, `End`,
`Typeset`, `getAllJax`, and file/processing error signals.

## Real-library fixture provenance

ADAPT source snapshot `ee9478b0`, `resources/views/header_html.blade.php:51` and
`resources/views/spa.blade.php:68`, loads cdnjs MathJax **2.7.3**, config
`TeX-AMS_HTML`, with Hub TeX/MathML/SVG settings. The synthetic tests select SVG
explicitly through `menuSettings.renderer` to prevent a browser menu preference
from selecting the HTML-CSS renderer. Both real TeX and MathML must produce SVG
in captures. Tests also cover ADAPT's default renderer selection.

`npm ci` reproducibly obtains the full original MathJax 2.7.3 library/assets,
pinned as a dev dependency in package-lock.json. Tests serve these actual files
only on loopback; no CDN is contacted. Apache-2.0 license is retained in the
installed package; no copied or modified library files are committed.

Archive: `https://registry.npmjs.org/mathjax/-/mathjax-2.7.3.tgz`

Integrity: `sha512-HEKJYRofOD5k9RmTj1amdA32JIJOqJ8SO+lq50mffZzdfFz+bNnsB0tJ8efMfYpiffvUHkqFRZFxXftW4BaBOw==`

SHA-256, asserted by the test before serving:

| Asset | Digest |
|---|---|
| MathJax.js | f3bbf1b342e93173df117394fed9b914afc1506eee6c04b92edb528d09893048 |
| config/TeX-AMS_HTML.js | 02a6199a83a04869684c04bad7cdbb250aa620eb263991ce8031d585dfc8dde3 |
| LICENSE | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 |

This intentionally old test fixture has npm advisories GHSA-3c48-6pcv-88rm
(moderate XSS, fixed after 2.7.3) and GHSA-v638-q856-grg8 (high ReDoS). Test
content is synthetic. Production code never imports or serves this dependency;
Docker prunes dev dependencies after compilation/browser installation. Upgrading
ADAPT's own library is outside this repo's authorization and remains an upstream
integration decision. `npm audit --omit=dev` must remain clean.

## Verification

`npm run test:browser` runs real Chromium through the public job seam on macOS
and native Linux CI, with fake tokens/keys and validators. The capture suite
covers valid iframe/SPA/no-math, 401/403/404/500, wrong routes/origins, actual
TeX/MathML, delayed loader/startup, skipped startup typeset, no-math with loader,
permanent queue blocking, library failure, unsupported major, parsing error and
navigation interruption. Linux isolation evidence remains a separate existing
suite. Container/Compose and actual owned full-stack proof remain release gates.
