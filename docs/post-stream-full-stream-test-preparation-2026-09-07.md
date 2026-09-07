# Full-Stream Comparison Preparation

## Status

Offline preparation was completed before full-stream transmission was authorized.
The user subsequently gave explicit permission, and the separate live executor
completed all 32 approved requests. See
[full-stream results](post-stream-full-stream-ab-results-2026-09-07.md): the
comparison completed but the performance and quality gates were not passed.
The preparation harness itself still has no live mode; automatic goal continuation
was never treated as permission, and the original frozen preparation is unchanged.

At preparation time, only three windows were authorized for remote transcript
experiments. No model call, upload, notification, image generation or publication
occurred during that offline preparation. Later full-stream text permission did
not authorize video/image transmission or publication.

## Frozen Inputs

Source: 2026-09-05 room `25788785`, recording ending in
`20260905-194103-480-..._merged`.

- 6,127 subtitle rows and 12,980 audience comments.
- Subtitle timeline end: 18,784.724 seconds.
- The same existing completed emotion-analysis sidecar for both variants.
- The original SRT, XML and ASR metadata are copied locally and hashed. The
  original recording and sidecars are not modified; media is not decoded.
- Baseline: `3fd814e24271663ad5d02b95e9ade6a9462d1c89`.
- Candidate: `650b424924d6efed731341249c1f8be19acd329b`.
- Both variants share the current validated text transport and compiled release
  `ecd0450cbeadd3aa9dc4`; selection and prompt helpers load from their respective
  Git revisions. This is not a comparison of every historical system component.

The earlier temporary staged script resolved its baseline from the current HEAD
at execution time. It must not be reused as an old-version comparison after
subsequent commits. The new loader records fixed revisions and all loaded source
hashes, including prompt helpers, not just the main clip script. Earlier recorded
experiment results remain unchanged and are not relabeled as this comparison.

The baseline's documented missing `buildEmotionContextLines` import is the only
baseline source patch, so a known startup failure is not counted as its speed.
There are 19 baseline modules, 41 candidate modules, and 87 total snapshots,
including shared runtime/dependency metadata and input data. The sanitized
configuration snapshot passes a recursive credential-field check.

## Request Boundary

- Order: baseline, candidate, candidate, baseline; maximum four batches.
- Seven 2,700-second recall chunks plus one global rerank per batch.
- Same existing concurrency 3, local candidate cap 80, final cap 50.
- Maximum 32 submissions, maximum eight per batch, no repeated stage submission.
- Existing daiYu endpoint: `http://localhost:8080/v1/responses`, forwarded by the
  user's existing gateway only after future explicit authorization.
- Fixed `gpt-5.6-luna`, `high`, 100,000 output-token limit, and existing 600,000ms
  selection request timeout; exact model, one attempt, no provider/model fallback.
- Single user text block, `stream=false`, `store=false`; no new system role,
  background mode, tools, images or cache-routing hint. Actual constructed request
  bodies are checked, not merely the requested option objects.
- Stage result cache disabled for matched cold-generation measurements. This
  changes only the isolated test configuration, not production configuration.

The dry run calls the actual versioned staged-selection entry point and current
text request builder. `node-fetch` returns a synthetic completed empty clips
object. Independent HTTP/socket and subprocess guards prevent bypassing that
mock; only allowlisted read-only Git subprocesses are permitted.

## Verification

Four offline batches completed, each with eight simulated submissions. Real
network requests: zero. Each version's two batches have identical prompt hashes,
request-body hashes and constrained request options. Both had 80 local candidates
and a pool of 79 after deduplication in this mock run.

The 17 focused tests cover endpoint and body validation, model/reasoning/budget
drift, changed roles or source text, image/tool insertion, unexpected batches,
repeated stages, exhausted request budgets, missing/corrupt snapshots, external
network/subprocess blocking and refusal of a live CLI mode.

Empty model output is deliberate: these are invocation and safety tests. The
candidate pool lacks actual first-stage model candidates, so prompt sizes,
selection counts, runtime and zero synthetic usage are **not** predictions of
the live comparison or evidence of selection quality.

## Predeclared Evaluation

The manifest lists six separate review dimensions: factual title/description
support; speaker/source attribution; complete setup/reaction/closing; independent
event coverage and duplication; faithful cover qualifiers; and citation linkage
versus semantic truth. Variant, timing and usage labels must remain hidden until
review notes are fixed. No independent reviewer assessment has occurred yet.

Record all recall/rerank attempts and IDs, wall time, input/cache/output/reasoning
usage, unknown usage, and proposed/accepted/rejected/post-alignment clips. Do not
select only a fast run or omit a failed batch. Two runs per variant cannot prove
production P95, and this selection-only experiment cannot complete the separate
goodnight/image/media acceptance gates.

## Local Artifacts

- Harness: `tmp/full-stream-ab-20260907.cjs`.
- Tests: `tmp/full-stream-ab-20260907.test.cjs`.
- Final preparation directory:
  `tmp/full-stream-ab-preparation-20260907/2026-09-07T13-13-31-992Z/`.
- `manifest.json` contains revisions, settings, hashes, request records, evaluation
  rules, authorization state and limits. Each mock prompt and the source snapshots
  remain under that directory; they are not committed or uploaded.
- Offline commands:
  `node --test tmp/full-stream-ab-20260907.test.cjs` and
  `node tmp/full-stream-ab-20260907.cjs verify <manifest-path>`.

No production code, configuration or service was changed in this preparation.
Other tasks' pending keyword-clip timeout edits remain outside this work.
