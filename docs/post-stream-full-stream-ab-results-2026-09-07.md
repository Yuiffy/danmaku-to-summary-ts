# Full-Stream Selection A/B Results

## Decision

The authorized four-batch comparison completed, but the complete-evidence
candidate **did not pass the no-slowdown or token-saving gate**. Mean selection
time was 803.066s versus 701.555s, about 14.5% longer. Mean input tokens increased
11.0%, uncached input increased 6.5%, and output tokens fell only 0.7%.

The candidate avoided the baseline's post-alignment duration overshoots, but
source-text spot checks still found a factual/action error in a candidate result
as well as baseline errors. Quality non-inferiority and stable event coverage are
not established. No production source, default setting, active compiled release,
media, reply, upload registry or publication was changed by this experiment.

## Authorization and Method

After the explicit request to send the complete 2026-09-05 SUI transcript and
audience comments, the user replied with permission. This newly expanded the
earlier three-window authorization. The prior offline preparation remains an
unchanged historical snapshot; the authorization is recorded separately in
`LIVE_EXECUTION.json` and the live run's `state.json`.

- Source: room `25788785`, 6,127 SRT rows, 12,980 audience comments, timeline end
  18,784.724s, and the same existing emotion-analysis sidecar in both variants.
- Baseline selection/prompt sources: `3fd814e`; candidate: `650b424`. The sole
  baseline patch imports its already-used `buildEmotionContextLines` function.
- Versioned prompt helpers are included, not just the main clip script. Both
  variants use the same frozen current transport and release `ecd0450cbeadd3aa9dc4`.
- The shared streamer label is `SUI`, as fixed during offline preparation; this
  is a versioned selection comparison, not a replay of every service entry point.
- Fixed order: old, new, new, old; seven recall requests plus one global rerank
  per batch, concurrency 3, local cap 80, rerank pool cap 100, final cap 50.
- All 32 requests used and returned `gpt-5.6-luna`, with `high` reasoning,
  100,000 output-token limit and the existing 600,000ms timeout. Each stage made
  exactly one HTTP request; no retry, alternate model/provider, tool or image input.
- Endpoint: the existing daiYu gateway at `http://localhost:8080/v1/responses`.
  Request bodies retain one user text block, `stream=false`, `store=false`.
- Stage result caching is disabled only in the isolated cold comparison. No
  explicit prompt-cache route was added; reported upstream cache reads are kept.
- Text-only test: no video/image upload, AI image generation, rendering,
  notification or publication. Selection timings exclude those other stages.

The live run lasted from `2026-09-07T13:49:02.948Z` to
`2026-09-07T14:39:12.773Z`. All four batches and all 32 requests completed.
Network guards recorded no unauthorized I/O. The execution script was unchanged
since before startup and was copied into the result directory for verification.

## Timing and Use

| Batch | Variant | Recall Wall | Rerank | Selection Total | Input | Cached | Output | Final Clips |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Old | 555.159s | 222.838s | 778.145s | 283,771 | 30,720 | 81,748 | 38 |
| 2 | New | 438.936s | 316.257s | 755.361s | 314,466 | 30,720 | 69,723 | 23 |
| 3 | New | 498.687s | 351.917s | 850.770s | 315,535 | 82,944 | 80,338 | 32 |
| 4 | Old | 435.200s | 189.620s | 624.964s | 283,964 | 52,224 | 69,345 | 23 |

Mean recall wall time fell about 5.3%, while mean rerank time rose about 62.0%.
The rerank's mean input grew from 86,716.5 to 105,852.5 tokens, and its mean
reasoning output grew from 6,633 to 13,006.5. The larger global evidence and
reasoning workload is the observed bottleneck; local millisecond-scale savings
do not offset it in this comparison.

Total reported use across the authorized 32 requests:

- Input: 1,197,736 tokens, including 196,608 cached input tokens.
- Output: 301,154 tokens, including 251,805 reasoning tokens.
- Total: 1,498,890 tokens. No unknown usage in these successful live requests.

These are actual reported token counts, not a gateway bill or a pricing estimate.
Local replay diagnostics reuse original request metadata and are not added again.
Two runs per variant do not establish production P95, statistical non-inferiority,
or that every future new-version run will be slower. This sample nevertheless
does not satisfy the stated performance acceptance condition.

## Selection and Boundaries

| Batch | Proposed | Accepted Before Alignment | Final After Overlap Filter | Final Duration Violations |
| --- | ---: | ---: | ---: | ---: |
| 1 | 40 | 40 | 38 | 9 |
| 2 | 23 | 23 | 23 | 0 |
| 3 | 34 | 32 | 32 | 0 |
| 4 | 25 | 25 | 23 | 6 |

The common configured range is 35-210 seconds, with the existing 5-second tolerance.
The old version's later subtitle alignment extended 15 final clips beyond 215s;
the longest was about 263.31s. The candidate's cue-based boundaries remained in
range. No media was rendered, so this checks plans, not new output videos.

The candidate's third batch lost two proposals to `invalid_time_range`: both
omitted all boundary/reference fields even though their source candidates were
not eligible for the validated recall-hint reuse. The program did not invent
missing references to accept them. These raw proposals remain available.

Final counts vary substantially within each version. The 50-clip limit is a cap,
not a quota, and clip count alone is not recall quality. In the anonymous time
groups, the first new batch did not select the bathing or later care-memory group,
while the second did. This is not a validated recall-rate metric, but it prevents
claiming stable coverage of those previously prioritized topics.

## Source-Text Review

All 116 final records were placed in anonymous review packets with actual cut
boundaries, full in-range speech, nearby boundary context and audience comments.
The packets are grouped only to avoid rereading overlapping source passages.

Before opening the variant mapping or aggregate measurements, the assistant
reviewed all 19 records in the three groups containing the previously prioritized
complex topics and adjacent proposals. Notes were fixed with SHA-256
`cc17624a29934c9f54fe3d7c1d2f3f9df26fd2b080e8932be5254858a83c07bd`.

| Scoped Review | Old | New |
| --- | ---: | ---: |
| Records reviewed | 10 | 9 |
| Clear source-text mismatch | 2 | 1 |
| Needs review or clarification | 3 | 3 |
| No substantive text mismatch found in scope | 5 | 5 |

Specific findings include:

- An old description turns a physiological-reaction question that was considered
  but not voiced into something actually asked. A new description similarly
  includes a later unasked question in the earlier conversation and invents a
  bathhouse setting not established by the clip.
- An old title reverses the driver/passenger roles, despite its own description
  correctly identifying who was scolded. Its boundary also includes the beginning
  of a different anecdote without its explanation.
- Other records mix an earlier audience message with the later memo-essay topic,
  or merge pre-broadcast editing with a present wish to delete a repost.
- Some copies preserve recollection, anonymous identity and a supported single
  hook correctly. Not listing every later episode is not automatically omission
  or a factual error when the selected video still includes those episodes.

This is a purposive source-text check, **not** an error-rate estimate over all
116 records, an independent human blind study, or verified audio/ASR truth. The
operator had already seen execution progress and earlier experiments. The other
97 public-copy records have not received this detailed review. No overall title
accuracy improvement is claimed from the 2-versus-1 count.

## Stage Cache Findings

The recorded candidate responses were replayed offline with an isolated stage
cache, then replayed again with model generation forbidden. The first replay's
candidate pool and selected clips exactly matched the paid response results.

| Candidate Batch | Recall Stages Rejected by Cache | Individually Valid Proposals | Outside Audience References | Warm Stage Hits | Whole Warm Result Identical |
| --- | ---: | ---: | ---: | ---: | --- |
| 2 | 7/7 | 27/56 | 61 | 0 | No |
| 3 | 6/7 | 39/55 | 35 | 1 | No |

"Invalid stage for cache" means the strict complete-response validator rejected
at least one proposal, not that every proposal was bad or every title was false.
Some current first-pass candidates retain review warnings. The cache correctly
does not label these entire responses as fully validated reusable output.

In batch 2, the valid rerank response was stored, but uncached recall stages meant
the forced-zero-generation warm replay had a different pool and could not reach
the same rerank prompt. Batch 3 stored one valid recall stage; its other misses
also prevented an identical full replay. Failed replays are not cache savings.

Only 5 of the 96 outside references were within one second of the clip boundary;
the largest gap was about 183.7s. Widening tolerance to manufacture cache hits
would weaken evidence quality. Of those references, 46 had only the density
bucket's displayed time, not an individual comment timestamp in the model input.
That is a concrete input-contract issue to investigate, not proof that timestamps
alone will repair all errors.

This local stage-result cache is distinct from the upstream input-prefix cache
whose reported tokens appear in the timing table.

## Next Work

Prioritize exact per-comment timing and clear per-candidate boundary/reference
reuse eligibility, then evaluate the expensive global rerank while preserving
the complete evidence. Do not weaken citation checks, drop facts, reduce model
reasoning, or add model retries merely to improve measured cache or speed numbers.
Any new remote experiment needs a new explicit request budget; the authorized
32-request run is finished and protected against automatic restart.

## Artifacts

Run directory:
`tmp/full-stream-ab-live-20260907/live-2026-09-07T13-49-02-947Z/`.

- `state.json`, `execution.log`: all starts, finishes, IDs, attempts and completion.
- `batch-*/recall-*/`, `batch-*/global-rerank/`: exact prompts, request bodies and
  original responses/results. No authorization header or API key is stored.
- `batch-*/plan.json`: raw accepted plans, final aligned plans, pool and diagnostics.
- `measurements.json`, `summary.json`: verified counts, usage, timing and decisions.
- `blind-review/`: 116 packets, 24 time groups and the frozen 19-record notes;
  `review-label-mapping.json` is kept outside the blinded packet directory.
- `cache-replay-batch-*/`, `cache-validation-batch-*.json`: no-network replay and
  per-proposal citation diagnostics.
- `executor-source.cjs`: SHA-256
  `d612ace1c9de1573cae780705aad51bd8069b2531576061eba0c3fdc5dcb8590`.

The execution/guard/review helpers passed 20 focused local tests. This turn did
not edit production code; other tasks' keyword-clip timeout edits were preserved.
The complete optimization goal remains unaccepted, including independent semantic
quality and full goodnight/image/first-clip/all-clips latency gates.
