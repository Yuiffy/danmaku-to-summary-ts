# Clip optimization plan reconciliation

Date: 2026-09-08. Compared the supplied `message.txt` against local HEAD
`7e0205e`, whose tracked remote reference was identical. The document's baseline
was `3fd814e`. Its operational instructions were treated as proposals, not as
permission to publish, spend money, switch branches, or deploy.

## What was already implemented

| Old plan item | State at HEAD | Decision in this change |
| --- | --- | --- |
| A: lost recall tail | `buildChunkSources` already provided complete grouped subtitles, but ignored the old 14,000-character cap | Restore bounded, lossless splitting; do not return to truncation |
| B: missing middle correction | Global rerank already consumes a deduplicated **complete** subtitle table, with context and evidence IDs | Keep this path and add a real-prompt regression; do not add a redundant summary/finalization round |
| C: local candidates take capacity first | Still present | Score the full deduplicated pool before applying the cap |
| D: repeated merged evidence | Still present | Recompute final-window counts/scores from source records |
| Raw ASR timing | `asrSource` and a hash-bound ASR sidecar already preserve source spans and correction provenance | Also preserve original word records; never label interpolated display times as precise |
| Evidence attribution | G/D IDs, exact audience times, person/clock checks and validated recall reuse already exist | Preserve them; linking is not semantic QA |
| Model parameters | `max` already supported; unknown effort still became `high`; fallback could lose the configured effort | Reject unknown values and preserve explicit effort across protocols/providers |
| Diagnostics/cache | Failed-attempt usage, completion-state handling and cross-process selection cache already exist | Reuse the transport and retain legacy cache behavior; add a separately budgeted strict path |
| Multi-cut, rendered-cover selection, independent QA | Not implemented in own-stream production | Add opt-in compiled stages and fail-closed upload gates |
| Model evaluation/prices | Previous Luna/high experiments exist; they did not establish a quality or speed win, or a confirmed gateway price table | Add reproducible offline/guarded paid entrypoints; no new paid calls in this change |

## Implemented behavior

### Recall

`maxSubtitleCharsPerChunk` includes evidence labels, text and overlap. Within
each time partition, whole evidence rows are packed into budgeted requests.
Adjacent character-budget splits reuse up to 30 seconds of preceding complete
rows when those rows and at least one new row fit. Oversized rows are split by
Unicode code point, retaining the original G-ID, source times and a text offset.
No word timestamps are invented. Oversized original source spans retain their
original bounds; their display text cannot certify precise cuts.

Cross-chunk deduplication compares all retained alternatives, so an intervening
distinct event cannot hide a duplicate. Final non-overlap policy is unchanged.
The unified candidate score formula and provenance are retained before capacity
selection. Local window rescoring counts distinct source rows, not unique text:
two identical comments still contribute twice. Audience, subtitle and emotion
score components are saved for inspection. Emotion contributes its peak score,
not one reward per overlapping window.

### Conservative editing and QA

New business stages are strictly compiled under `src/workflows/clipping`;
the existing JS facade owns media/provider IO. Both serial and parallel
own-stream jobs now use the same single-clip generator.

- `editPlan` v1 records source identity, source window, ordered absolute
  half-open keep intervals, removals and evidence IDs. Reordering, overlapping,
  gaps, unknown evidence, source changes and boundary truncation are rejected.
- A removal requires independently verified audio precision <= 50 ms. Speech,
  its original ASR source span, a 200 ms safety margin and normal short pauses
  are protected. Silence retains 300 ms transitions. Laughter and unsupported
  event kinds cannot be removed. Legacy SRT without source timing stays intact.
- The edited media path reuses the existing copy rough-cut origin correction,
  synchronized `trim`/`atrim` and concat, mapped subtitles and final burn.
  NVENC failure can retry the same edit with CPU encoding; it cannot silently
  emit a continuous video with an edited SRT. Legacy continuous media is unchanged.
- Packaging reads complete source/retained evidence, generates at most three
  titles and actual rendered covers, then submits the rendered images to a
  separate cover-selection request. Existing frame acquisition/templates are used.
- Independent QA receives complete context, retained subtitles, final copy,
  the rendered cover and three final-video frames. Programmatic checks include
  audio/video presence, duration/start alignment, subtitle range and media decode.
- One packaging repair is allowed. If it fails, restore the continuous artifact
  and neutral copy and audit again. Still-failing artifacts have no upload ID.
- QA binds SHA-256 of video, SRT, cover and public copy. JSON import and queued
  upload validation recheck these, including changed registry titles/paths.
  `uploadReady` is eligibility only, never upload approval. Existing review/ID
  selection remains the authorization boundary.

The audio detector is deliberately **not** synthesized from SenseVoice event
labels or subtitle gaps. Editing needs a matching, trusted
`<source.srt>.edit-evidence.json` with `version: 1`, `sourceId`, and `events`.
Each event has `id`, `sourceId`, `kind`, `start`, `end`, `verified` and
`precisionSeconds`. `sourceId` binds absolute source path, size, mtime and source
SRT hash; it is also saved in the resulting plan. No verified events means no
automatic removals. Deployment of a reliable detector remains a prerequisite
for broad automatic cough/silence removal.

### Stage configuration and budgets

Enhancements are **off by default**, with an empty room allowlist. Production
JSON files and the active compiled-release pointer were not changed.

`ownStreamClips.enhancements` accepts `enabled`, `roomIds`, `editing`, `budget`
and `stages` keyed by `edit`, `packaging`, `cover`, `qa`.
Optional selection routing uses `ownStreamClips.ai.stages.recall/rerank`,
`stageRoomIds`, and `stageBudget`. Use the same ledger and budget across all
stages of a campaign; legacy routes are not retroactively billed by this ledger.

Each stage requires:

```json
{
  "provider": "daiYu",
  "model": "gpt-5.6-luna",
  "apiMode": "responses",
  "reasoningEffort": "high",
  "maxTokens": 4000,
  "maxInputTokens": 32000,
  "timeoutMs": 600000,
  "capabilities": {
    "reasoningEfforts": [],
    "images": false
  },
  "price": {
    "confirmed": false,
    "version": "replace-with-confirmed-channel-tariff",
    "inputCnyPerMillion": 0,
    "cachedInputCnyPerMillion": 0,
    "outputCnyPerMillion": 0
  }
}
```

This example intentionally cannot spend money. Verify the exact gateway model
and effort first. Cover/QA stages additionally require verified image support
and `imageTokenUpperBound`. Official image transport schema is documented at
<https://developers.openai.com/api/docs/guides/images-vision>; this does not
establish the private gateway aliases' capabilities or prices.

Budget fields: absolute shared `ledgerPath`, `globalCny`, `roomCny`,
`sessionCny`, optional `holdoutReserveCny`. Missing or invalid limits fail closed.
Reservations are serialized with an exclusive filesystem lock and atomic JSON
replacement, including across processes. A crash leaves an outstanding
reservation; it is never automatically forgiven. Unknown/future usage keeps the
reservation charged, with actual cost explicitly null. Known final usage is
settled, including empty/truncated failures. Reasoning is already included in
output tokens and is not charged twice. Unverifiable routing or extra attempts
require reconciliation before further paid work. A stale lock requires operator
inspection, not automatic lock stealing.

Strict stages disable model/provider/protocol fallback, transient retries and
cache-parameter compatibility retries. The ledger records phase, attempt,
parameters, request/response IDs, returned model/effort, raw usage, elapsed time,
price version and cost. Unreported returned capability is labeled unverified.

## Reproducible checks

```powershell
npm run build:workflows
npm run clips:eval
npm run clips:eval -- --environment production --srt "path/to/source.srt" --xml "path/to/source.xml"
node -r ts-node/register/transpile-only src/tools/clipping/verifyEditMedia.ts
```

Default evaluation is offline. The checked-in fixture covers the requested
matrix without assuming the CLI's development configuration is production.
Use `--environment production` to snapshot the production loader configuration;
the inspected production baseline is daiYu/Luna/high, Responses, 100,000 output
tokens. Without that option the report explicitly records the current loader
environment. The fixture covers the requested
Luna/Sol/Astra matrix but intentionally has unverified capabilities and prices.
`--manifest` accepts frozen stage prompts, optional actual image paths and
explicit references. Samples are split by entire session; missing uploads do
not create negative labels. Known-bad QA cases measure false acceptance.
Other semantic metrics remain null until suitable human annotations exist.

`--execute-paid` is an explicit operator action and still requires confirmed
prices/capabilities. Paid evaluation always uses
`data/runtime/clip-evaluation-ledger.json`, a cumulative 100 CNY ceiling and
40 CNY screening exclusion for holdout work. Output directory changes do not
reset this budget. It stops on a failed stage instead of silently retrying.
Raw request/response artifacts and a report are written under the selected
output directory. No winning model or recommended lower effort is claimed.

## Results and remaining gates

- Frozen real 2026-09-05 input: **6,127/6,127 subtitle rows covered**, 12,980
  audience comments, 12 budgeted recall chunks (previously seven), maximum
  14,000 subtitle characters per request. This is coverage validation, not a
  latency, semantic-quality or total-token savings claim.
- Corpus report: `tmp/clip-optimization-corpus-20260908/report.json`.
- Matrix preparation: `tmp/clip-optimization-offline-20260908/report.json`,
  40 prepared/blocked stage cases, zero model requests and zero new spend.
- Synthetic actual FFmpeg validation: continuous 20 s versus edited 14.6 s;
  edited video 14.58 s/audio 14.60 s, preserved ending caption visually checked.
  Both use copy two-stage burning and configured GPU encoding. The existing
  ASR guard throttled FFmpeg to one thread; it was not disabled.
  Artifacts: `tmp/clip-edit-media-validation/`. This is not a real-stream
  editorial A/B trial or a blind listen test.
- `verify:all` was attempted. Type/build checks passed; architecture stops at
  pre-existing `audio_processor.js` 1622/1496 and `sensevoice_speaker.py`
  2388/2331. No budget was raised and those files were not modified.
- Final verification: Jest **88 suites / 977 tests**, Node **12 tests**, Python
  **266 tests**, compiled integration **7 tests** passed. Type-check and service
  build-check passed. Concurrent workspace recovery/notification changes were
  preserved and their initially incomplete tests passed on the final rerun.
- Candidate compiled release: `9042435581800ccbe657`. The inspected active
  pointer remains `ecd0450cbeadd3aa9dc4`; this task did not activate or restart it.

Remaining rollout gates: confirmed channel tariffs/capabilities, a trusted
precise audio detector, human-reviewed multi-session/holdout samples, live
visual QA evaluation and real-stream edited/continuous blind comparison. Keep
enhancements off until those gates pass. Build candidates are not production
activation; use the repository's existing reviewed release procedure.
