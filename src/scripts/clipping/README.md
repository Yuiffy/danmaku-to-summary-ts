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
  routing, and held candidates on failure. See `docs/topic-preflight-comparison-2026-09-07.md`.
- `preflight_quality.js`: quality-focused preparation and optional independent
  audit with source-linked repairs before rendering. `preflight_facts.js` loads
  user-confirmed facts and patches scoped by source path, hash, and time range.
  See `docs/topic-preflight-quality-cost-2026-09-07.md` for quality-first acceptance
  and the cost comparison; the extra audit is not enabled by default.
- `topic_editorial.js`: joint keyword-context event selection and locked-interval
  copy evidence. `topic_editorial_runner.js` uses the shared validated AI cache.
  See `docs/topic-event-editorial.md` for duration, attribution, and review policy.
- `own_selection.js`: own-stream candidate recall, scoring, and subtitle alignment.
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

## Event contract

Detectors may use their own internal measurements, but the handoff to a
compiler should be a JSON object with `source.mediaPath` and canonical events:
`id`, `sourceId`, `start`, `end`, `duration`, `score`, `evidence`, and
`metadata`. Legacy detector fields such as `firstHit`/`lastHit` and
`peakScore` are accepted by `event_manifest.js` and normalized at the
boundary. A detector-specific ROI, waveform threshold, or template stays in
the detector adapter and does not belong in this shared module.
