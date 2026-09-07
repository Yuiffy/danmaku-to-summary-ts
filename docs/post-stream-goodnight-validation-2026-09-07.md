# Goodnight Retry and Production Cache Validation

## Production Evidence

Read-only inspection of the current production log and saved artifacts found an
unnecessary goodnight rewrite on 2026-09-07 in room `26966466`.

The first reply was 137 characters and had two substantive sentences separated
by a full-width exclamation mark (U+FF01). The source CLI counted ASCII `!` and
`?`, plus the Chinese full stop, but not full-width exclamation/question marks.
It rejected this reply as one sentence and generated a second version.

| Event | UTC Time | Log Line |
| --- | --- | ---: |
| Goodnight generation started | 08:56:19.591 | 16198 |
| First complete reply falsely rejected | 08:56:38.698 | 16226 |
| Second reply saved | 08:56:55.791 | 16247 |
| Comic generation started | 08:57:09.389 | 16287 |
| Comic script usage logged | 08:58:33.241 | 16309 |
| Comic image saved | 09:01:28.863 | 16387 |

Log: `logs/pm2-combined-0.log`; the local audit records a hash of the snapshot so
line references remain attributable if the active log later rotates.

The extra rewrite reported 118,690 input tokens, including 117,504 cached tokens
and 1,186 uncached input tokens, plus 663 output tokens. The interval from false
rejection to the saved replacement was 17.093s, including the existing 2s retry
delay. These are recorded historical costs, not refunded tokens or a claim that
the whole downstream workflow will become exactly 17s faster. Avoiding this
rewrite also changes subsequent cache history, so downstream latency needs its
own measurement.

## Changes

- Recognize U+FF01/U+FF1F as sentence boundaries. Punctuation runs and trailing
  quote/symbol fragments do not count as substantive sentences. The minimum
  length, two-sentence threshold, fan-name guard, model, reasoning and output
  token budget remain unchanged; accepted text is not rewritten locally.
- The outer goodnight retry loop now stops when the provider explicitly reports
  a queued/in-progress or otherwise flagged unknown outcome. It returns no
  publishable Markdown and logs `GOODNIGHT_OUTCOME_UNKNOWN` with the original
  request/response IDs, attempts, and known partial usage.
- A definitive HTTP error with unknown billing is not confused with a known
  in-progress response. Existing ordinary retries and complete-but-invalid
  content retries remain available. Existing completed output files still reuse
  normally and no historical output or failed draft was replaced.

The lower provider loop already stopped on queued/in-progress results, but the
outer goodnight loop called it again. Four complete-entry tests, covering both
daiYu and tuZi with both states, reproduced three submissions before the fix and
one after it. The tests mock HTTP responses, not the public goodnight function,
and retain the configured fallback-provider path to verify it does not submit.

This is not background-mode rollout or automatic response retrieval. Official
OpenAI documentation identifies queued/in-progress as nonterminal states and
describes retrieving the same background response; it also describes retention
and latency implications. The current compatibility gateway's retrieval support
has not been validated. We did not change `background`, `store`, model, roles,
or request-body format to obtain these fixes.

Reference, fetched 2026-09-07:
[OpenAI Background Mode](https://developers.openai.com/api/docs/guides/background).

## Actual Cache Observations

Two recent production contexts demonstrate both a real large-prefix hit and the
limits of routing. Rows below are separate requests, not duplicated totals from
multiple log labels.

| Context and Task | Input Tokens | Cached Tokens | Output Tokens |
| --- | ---: | ---: | ---: |
| Room 26966466, first goodnight | 118,635 | 0 | 637 |
| Room 26966466, false-rejection rewrite | 118,690 | 117,504 | 663 |
| Room 26966466, live-content summary | 117,520 | 0 | 344 |
| Room 26966466, comic script | 120,141 | 116,480 | 4,459 |
| Room 30655190, goodnight | 25,505 | 3,840 | 729 |
| Room 30655190, comic script | 25,921 | 3,840 | 2,717 |

The first context uses the full-live prefix with key `bc403443...`; the second
uses a normalized-highlight prefix with key `804af667...`. Each context shares
its own key, not a common key across the two recordings. For the first rewrite,
the raw attribution reports all 117,137 input tokens in the shared fact block
as cached, plus 335 task-suffix tokens and 32 instruction tokens. This is not
merely the recurring 3,840-token instruction-cache hit.

The comic script's saved metadata matches its logged token counts and contains
its request and response IDs. Its full-live source hash matches the shared source
artifact, whose prefix hash matches the request key. The comic hit is about 97%
of its input; the live-content request in the same sequence has zero cached input.
The second context has no evidence of a new user-fact-block hit.

These observations verify production cache use, not universal hit rate, gateway
billing discounts, a comparison between equivalent inputs, or a matched latency
improvement. The observed first context took 36.200s to save goodnight text and
259.474s from comic entry to image saved; 309.272s elapsed from goodnight entry
to image saved. No old/new matched run or production P95 is inferred from them.

## Verification

- The saved rejected reply replays against Git baseline `0a03023` as one sentence
  and against the fix as two, preserving all 137 characters.
- All 19 existing goodnight replies found through current-log ready sentinels
  remain accepted, with identical cleaned bodies.
- New tests cover Chinese/ASCII sentence boundaries, repeated punctuation,
  trailing quotes, unchanged successful publication, existing-file reuse,
  genuine content retry, terminal HTTP retry, and unresolved provider responses.
- All 80 Jest suites / 914 tests pass, as do 11 Node tests, type-check and build
  checks. Architecture check has only the two existing ASR line-budget failures:
  `audio_processor.js` 1622/1496 and `sensevoice_speaker.py` 2388/2331. No budget
  was raised and neither module was changed.
- No production transcript was sent in a new request, no AI image was generated,
  and no reply/image/upload record was modified or published by this validation.
  The compiled release pointer was not changed and no service was restarted.

Local audit: `tmp/audit-goodnight-production-20260907.cjs`.
Evidence: `tmp/goodnight-production-audit-20260907.json`, including source hashes,
log lines, request metadata, timings and replay verdicts. Tests live in
`src/scripts/ai_text_generator.goodnight.test.ts` and
`src/scripts/text_attempt_diagnostics.test.ts`.

The gate is still incomplete for independent semantic blind review and matched
end-to-end goodnight/image/selection latency. This fixes two identified duplicate
generation causes without weakening the existing policy, not all semantic errors
or all ambiguous upstream completion cases.
