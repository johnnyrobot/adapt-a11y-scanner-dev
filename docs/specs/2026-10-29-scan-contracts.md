# LT-120: Source-backed scan contracts

Parent: [LT-114](https://linear.app/johnnyrobot/issue/LT-114), release LT-111. The Chief resolved the contract and no-work decisions on 2026-10-29. This slice follows sandbox PR #6 without modifying its behavior.

## Problem Statement

Assignment scans request metadata from the wrong ADAPT endpoint, then guess question-list keys and silently accept missing data as empty success. The Remedy parser can also turn malformed findings into an empty passing result. Operators need reports that distinguish valid accessibility evidence, failed contracts and no work.

## Solution

Use the source-verified assignment-ID endpoint and validate the complete supported HTTP validation envelope before normalizing findings. A recognized empty assignment is an explicit unsuccessful no-work report. Preserve sequential scans, legitimate warnings and supported optional fields.

## User Stories

1. As an operator, I want assignment scans to enumerate real question IDs instead of assignment metadata.
2. As an operator, I want unknown or malformed responses rejected instead of silently skipping questions.
3. As an operator, I want an empty recognized assignment reported as no work so it cannot certify accessibility.
4. As a maintainer, I want fixtures pinned to source and serializer evidence so compatibility changes are deliberate.
5. As a reviewer, I want warning, null-impact and partial-checker outcomes preserved without interpreting English summaries.
6. As an integrator, I want additive keys accepted while known fields retain their actual types.

## Implementation Decisions

- ADAPT source snapshot `ee9478b0b418d222c17a15a004a36cec43858dfd`: GET `/api/assignments/{id}/questions/ids` requires `type=success` and a real `question_ids_array`. Ignore the legacy JSON-encoded duplicate `question_ids`. Reject `type=error` even HTTP 200 and remove unverified `questions`/`question_info`/`data` fallbacks. Require positive safe integer numbers or positive decimal-digit strings; retain string form without numeric conversion.
- Recognized empty arrays produce zero totals/results, `exitCode: 1`, additive `outcome: 'no_work'` and a clear `message`. HTTP remains 200 with `ok: false`, derived from exitCode. Unknown envelopes are contract errors, never no-work. Nonempty report vocabulary remains unchanged.
- Server snapshot `78710dc0af53d3e63a662fb392b5190f2e2d0dab`: require boolean `overall_passed`, array `all_violations`, string `summary` and `axe`/`pa11y`/`lighthouse`/`wave` objects with boolean `passed`, array `violations`, nullable finite numeric `score`. Additive keys are permitted. No alternate findings/results/issues envelopes or invented payload version field.
- Findings require string `tool`, `id`, `description` (including legitimately empty strings), and impact `critical`/`serious`/`moderate`/`minor`/null. Optional strings: wcag, selector, context, help, help_url; optional html_snippets is a string array, nodes_count a nonnegative integer, finding score a finite number. Do not require Lighthouse wcag/selector or coerce wrong types into valid records.
- Reject contradictory would-be passes, including severe findings hidden in a tool collection, omitted findings in a purported clean merged result, or a failed empty checker paired with a true global verdict. Preserve an explicit false verdict even with zero findings. A Lighthouse tool flag may fail its score threshold while the global verdict legitimately passes with only moderate findings; do not replace the global policy with an all-tool-flags AND.
- Critical/serious HTTP impacts map to error; moderate/minor/null map to warning. Preserve existing direct-core canonical severity mapping. Non-2xx and non-JSON remain operational failures. Summary is display text, never control flow. WAVE's empty/passed placeholder does not prove WAVE execution.
- Deepen existing client/parser validation and job reporting; no generic schema framework, public dependency-injection interface, or cross-repo code change.

## Testing Decisions

Use Matt TDD at the already approved client/parser and real job/API seams. Preserve the source-supplied serialized fixtures byte-for-byte; malformed cases are explicit mutations of a fresh copy. Exercise HTTP transport with real loopback fixture services and run the actual renderer/CLI/API with fake external providers. Cover source-backed pass/warning/accessibility failure/partial/null impact, additive fields, valid optional shapes, malformed envelopes/records, non-2xx/non-JSON, ADAPT errors, IDs and recognized empty work. Assert no validator call for no-work/unknown assignments and nonzero CLI/HTTP outcomes. Browser checks use the real sandboxed Chromium installed for the existing CI job.

Prior art: existing client/parser/report tests and real renderer integration suite. Keep sandbox/native Linux regression coverage unchanged. Full pre-open/pre-merge Standards + Spec + fresh-context Correctness gate and one external review apply.

## Out of Scope

Live ADAPT or Remedy verification, credentials, deployment, external repo edits, TestSprite, capture/auth-document rejection, MathJax readiness and resource cancellation/admission. Those remain separate LT-114 gates.

## Further Notes

Durable fixture manifest: `test/fixtures/contracts/v1/remedy-html-validation.json`, copied from `/Users/libretexts/code/remedy-html-validation-v1-fixtures.json`. All four recorded Server source-file SHA-256 values were independently checked against pinned Git objects. `contract_id` versions documentation only; the payload carries no such field. Generation exercised real validation orchestration/serialization with synthetic tool adapters, not real browser/tools/HTTP. ADAPT fixture provenance is the pinned route/controller source, not a live server response. Live-version compatibility and actual Server browser/tool execution remain unverified; re-confirm with Server owner when contracts evolve.
