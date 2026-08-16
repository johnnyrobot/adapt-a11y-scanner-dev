# Third-party components

No upstream source is vendored here, and `dist/` is not committed — it is built
during `docker build`. Everything is resolved from `package-lock.json`.

**Running this raises no licensing question.** The obligations attach when you
redistribute a **built image**.

This is the smallest dependency surface of the three Remedy repositories: **four
production npm packages, all permissive, none copyleft.** Almost everything in
the image comes from the base image rather than from `package.json`.

## What the built image contains

| Component | Pinned | License |
|---|---|---|
| [mcr.microsoft.com/playwright](https://mcr.microsoft.com/en-us/product/playwright/about) | `v1.60.0-jammy` | MIT (Playwright) over Ubuntu 22.04, mixed |
| Chromium, Firefox and WebKit builds bundled in that base image | matches `v1.60.0` | BSD-3-Clause, MPL-2.0, LGPL and others |
| `playwright` | 1.60.0 | Apache-2.0 |
| `playwright-core` | 1.60.0 | Apache-2.0 |
| `dotenv` | 16.6.1 | BSD-2-Clause |
| `fsevents` | 2.3.2 | MIT (macOS-only, optional; not installed in the Linux image) |

Development-only, not in the image: `typescript`, `@types/node`.

## The browsers are the bulk of it

Four npm packages is misleading. The base image ships complete builds of
Chromium, Firefox and WebKit, and those carry a licence set far larger than
anything in `package.json`: Chromium is predominantly BSD-3-Clause with a long
list of bundled third-party components, Firefox is MPL-2.0, WebKit is LGPL-2.1
and BSD.

If you redistribute this image, that is what you are mostly redistributing.
Microsoft publishes the base image's own component manifest, and it is the right
reference — not this file — for the browser layer.

The `Dockerfile` deliberately pins the base image tag to the `playwright`
version in `package.json`, because the client and the bundled browser build are
version-locked. Bumping one without the other breaks `chromium.launch()` at
runtime, so the pin is a functional constraint, not only a licensing one.

## What this scanner does not contain

It does **not** bundle `axe-core`, `pa11y` or `lighthouse`, despite handling
their output. The scanner renders pages with Playwright and normalises severity
values; the rule engines run in **Remedy Server**, whose own `THIRD-PARTY.md`
covers them — including `pa11y`, which is LGPL-3.0-only.

`@libretexts/remedy-core` is likewise **not installed here**. It is used only in
an in-process development mode and is intentionally excluded from the image, as
the `Dockerfile` notes.

## Content this software touches

The scanner fetches and renders ADAPT course content. **That content is not
covered by this repository's licence** and carries whatever terms the source
material carries.

## Why this repository is MIT

Everything under `src/` is original work. Nothing here contains or modifies
copyleft source; the copyleft components in the image belong to the browsers
shipped by the base image, consumed unmodified.

## Refreshing this file

```bash
npm ls --omit=dev --all --parseable | tail -n +2 | while read -r d; do
  [ -f "$d/package.json" ] && node -p "
    (p => [p.name, p.version, (typeof p.license === 'string' ? p.license : (p.license||{}).type) || 'UNKNOWN'].join('  '))
    (require('$d/package.json'))"
done | sort -u
```
