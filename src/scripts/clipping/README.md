# Clipping Modules

This directory contains reusable clipping and evidence-processing modules.

The broader placement rules for `src/scripts` are documented in
`src/scripts/README.md`. This directory is for shared clipping contracts and
adapters; a date-specific detector or a one-off compilation stays under the
ignored `temp/` tree until its inputs and behavior are made configurable.

## Layout

- `topic_selection.js`: keyword matching, context windows, deduplication, and
  subtitle boundary decisions for topic clips.
- `topic_config.js`: topic workflow defaults and configuration merging.
- `preflight_evidence.js`, `preflight_plan.js`, `preflight_runner.js`: prepare and
  validate the complete edit, local subtitle patches, and public copy before any
  render or cover work. Supports single-call or staged preparation, exact model
  routing, and held candidates on failure. See
  [Preflight Review](../../../docs/topic-event-editorial.md#preflight-review).
- `preflight_quality.js`: quality-focused preparation and optional independent
  audit with source-linked repairs before rendering. `preflight_facts.js` loads
  user-confirmed facts and patches scoped by source path, hash, and time range.
  Acceptance checks are documented in the same preflight contract; per-run
  quality/cost comparisons stay local. The extra audit is not enabled by default.
- `topic_editorial.js`: joint keyword-context event selection and locked-interval
  copy evidence. `topic_editorial_runner.js` uses the shared validated AI cache.
  See `docs/topic-event-editorial.md` for duration, attribution, and review policy.
- `own_selection.js`: own-stream candidate recall, scoring, and subtitle alignment.
  Model-visible audience IDs include each comment's original precise timestamp,
  distinct from density-bucket clocks; sampling and source text are preserved.
- `rerank_evidence.js`, `selection_result.js`: compact evidence and validated
  selection results. Every candidate carries a validated `reuse` object or
  explicit `null`; context range `g` is not a default cut boundary. Missing
  boundaries on non-reusable candidates are rejected with a specific diagnostic,
  not guessed. A model-supplied `reuse` cannot grant omission permission; the
  diagnostic is `missing_explicit_boundaries`. Tests cover exact audience times,
  stale evidence and forged reuse. More explicit evidence can increase input;
  do not infer live-model speed or cost savings from offline preparation checks.
- `person_evidence.js`: local configured-name citation warnings for final own-stream
  copy. Formal/search names and copy labels are matched literally; broad mention,
  ASR alias, and generated speaker labels are not identity evidence. Checks use
  only cited, provided, in-window text and never trigger a model retry or remove
  a clip. Source-host metadata and audience mentions remain distinct from speech.
- `subtitle_evidence.js`: final revalidation compares cited audience text and exact
  timestamps with saved snapshots because D-IDs are positional. Changed or missing
  snapshots remain reviewable in `audienceChanges`, preserving the original through
  subsequent output passes. Unchanged citations do not depend on unrelated rows.
- `selection_cache.js`, `selection_outcome.js`: share one in-flight stage across
  local processes, including its failure or uncacheable result. Attempt outcomes
  are addressed only by an observed generation ID, never used as a successful
  stage cache or a failure cache for a later independent request. Missing owner
  outcomes remain unknown without an automatic replacement submission. Journal
  records older than 24 hours are removed when another outcome is published.
- `topic_compilation.js`: discover recordings, search SRT/XML evidence, build a
  reviewable cross-recording plan, and compile the selected windows.
- `event_manifest.js`: normalize detector output into one event contract and
  perform score-aware overlap selection.
- `resource_scheduler.js`: adaptive FFmpeg worker and thread scheduling.
- `output_path.js`: map archive recordings to the active output tree.
- `*.schema.json`: machine-readable contracts for detector/compiler boundaries.

The large Sui workflows in `src/scripts/topic_clipper.js`,
`src/scripts/own_stream_clipper.js`, and `src/scripts/manual_clip_queue.js`
remain at their historical paths for compatibility. New shared code belongs
here; the root files should depend on these modules instead of adding more
cross-workflow helpers.

These extracted JS modules preserve the existing source-executed Node runtime.
They must not import their parent workflows. Pure decision changes can be tested
without FFmpeg, an AI provider, an upload queue, or a service restart.

`src/scripts/clip_resource_adaptive.js` and `src/scripts/clip_output_path.js`
are compatibility entrypoints. New imports should use this directory.

## Optional Own-Stream Enhancements

`enhancement_runner.js` owns media/provider IO around strictly compiled stages in
`src/workflows/clipping`. `ownStreamClips.enhancements` requires `enabled: true`
and an explicit `roomIds` allowlist, plus `editing`, `budget` and `stages` for
`edit`, `packaging`, `cover` and `qa`. Enhancements are opt-in; building a candidate
workflow release does not activate it. Follow the deployment procedure in
[Architecture](../../../docs/architecture.md#compiled-workflow-releases).

The versioned edit plan binds source identity, ordered keep intervals, removals
and evidence. Removal requires trusted `<source.srt>.edit-evidence.json` containing
`version: 1`, `sourceId` and `events` with `id`, `sourceId`, `kind`, `start`, `end`,
`verified` and `precisionSeconds`. Precision must be at most 50 ms; source speech
and timing margins are protected. Subtitle gaps and SenseVoice event labels alone
are not verified deletion evidence. Missing evidence leaves the source intact.

Packaging uses the actual rendered covers. Independent QA checks source context,
retained subtitles, public copy, the cover, final frames and media integrity. One
packaging repair is allowed before restoring the continuous artifact and neutral
copy for another audit. Still-failing media receives no upload ID. QA binds hashes
of video, SRT, cover and copy; registration and upload validate them again.
`uploadReady` means eligibility, never permission to upload.

Strict stage configurations require confirmed channel prices and capabilities,
explicit model/protocol/effort and input/output limits. Cover/QA also require
verified image support and `imageTokenUpperBound`. Budgets use an absolute shared
`ledgerPath`, `globalCny`, `roomCny`, `sessionCny` and optional `holdoutReserveCny`.
Unknown outcomes keep their reservation; inspect stale locks and reconcile usage
before retrying. There is no implicit provider/model fallback or automatic retry.

Portable evaluation and synthetic media verification entrypoints:

```powershell
npm run build:workflows
npm run clips:eval
npm run clips:eval -- --environment production --srt "path/to/source.srt" --xml "path/to/source.xml"
node -r ts-node/register/transpile-only src/tools/clipping/verifyEditMedia.ts
```

Evaluation is offline by default. `--manifest` selects frozen prompts, references
and optional images; split samples by whole session. `--execute-paid` additionally
requires explicit spending authorization and confirmed prices/capabilities. Its
cumulative ledger is `data/runtime/clip-evaluation-ledger.json`, with a 100 CNY
ceiling and 40 CNY reserved for holdout work; changing output directories does not
reset it. Run-specific inputs, requests, results and reports belong in ignored
`temp/` or `tmp/`, not shared fixtures unless reduced to portable regression cases.

## Actor Attribution Review

Own-stream attribution is configured separately from image/editing enhancements.
`ownStreamClips.attribution.enabled` plus an explicit `roomIds` allowlist is
required. Defaults are disabled. `participant_context.js` adds source-bound
planned participants, repeated local voice matches, and mentioned-only people;
none of those alone is proof of an action. It retains bounded additional identity
comments with exact D-IDs in recall and rerank without removing existing samples.

`actor_review_runner.js` requests independent, local-window claim review only for
high-risk clips. Complete speech is retained. `batchSize`, `maxBatchChars`,
`maxRequests`, `maxElapsedMs`, `timeoutMs`, and `maxTokens` bound the work; one validation repair
is allowed by `repairAttempts: 1`. Transport retries and provider/model fallback
are disabled for these calls. Oversized, failed or unresolved records retain
`publicCopyPending` and do not become upload-eligible. Actual usage appears under
`aiStatus.requests` with `actor-review-*` phases; no cached/replayed call is billed
again. The channel's reported usage, not a nominal output-limit setting, is the
accounting authority.

Batches run at bounded `concurrency` (default 2, maximum 3). The shared elapsed
budget defaults to 20 minutes and stops starting new batches, dialogue analyses
or repairs after that point; already-started requests finish under their own
timeout. Exceeding either budget never approves the remaining clips.

Each approved action records narrator, actor, target, source kind and in-window
speech IDs. Voice identity citations must match structured acoustic evidence;
room metadata and audience mentions do not prove the speaker. Known guest
actions use their configured `aiClipName` in the title. Voice is still probabilistic,
and citation validation is not a substitute for semantic/human review.

The final `attributionReview.artifactCopyDigest` binds the actual title, cover
text and source-prefixed description. `artifactDigests` also binds the generated
video and SRT, while `artifactWindow` binds the source interval. Subsequent changes or removal of required
review metadata are rejected by JSON import and upload-queue validation. This
gate grants eligibility only, never upload authorization. Enable production only
for explicit room allowlists after real multi-person and single-person comparisons;
do not generalize small-sample results into a global accuracy guarantee.

`evidenceEncoding: "compact"` is an experimental lossless representation of all
audience records using shared rows and an optional repeated-text dictionary.
Every clip retains its own allowed D-IDs. `legacy` remains the default; reduced
character count alone does not establish token savings or equal model quality.

`dialogueEnabled: true` adds an independent text-turn analysis only after the first
actor review leaves identity unresolved in a plausible multi-person window,
within the same request budget. Local text mentions can trigger analysis without
a planned roster, but do not certify presence. The analyzer receives source speech,
audience comments and name metadata, never prior titles or acoustic labels.
High-confidence turn hypotheses need at least two source anchors; ambiguous
multi-speaker cues cannot establish identity. The final reviewer rechecks these
hypotheses against the original text and may use `identityBasis: "dialogue"`
without a voice reference. Conflicts with direct local acoustic evidence stay
pending. Static avatars indicate visible participation, not proof of speaking;
visual turn inference remains an isolated experiment, not a default identity source.

## Event Contract

Detectors may use their own internal measurements, but the handoff to a
compiler should be a JSON object with `source.mediaPath` and canonical events:
`id`, `sourceId`, `start`, `end`, `duration`, `score`, `evidence`, and
`metadata`. Legacy detector fields such as `firstHit`/`lastHit` and
`peakScore` are accepted by `event_manifest.js` and normalized at the
boundary. A detector-specific ROI, waveform threshold, or template stays in
the detector adapter and does not belong in this shared module.
