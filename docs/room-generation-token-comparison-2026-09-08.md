# Room Generation Token Comparison

## Decision

Do not roll out Shiori's full-context goodnight, summary and comic experiment to
Miting or Mizuki on the condition that the increase should be small. Observed
text tokens per completed recording are 7.7-8.4 times the comparison groups.
Known uncached input is still approximately 6.8-7.3 times as large. Image token
usage is similar; the longer reply is not the main source of the increase.

No room configuration was changed, no service was restarted, and no AI request
or publication was made for this audit. Existing unrelated worktree changes
were preserved.

## Scope and Evidence

- Recording dates: 2026-09-01 through 2026-09-07, inclusive, using local recording
  directory dates. Snapshot: 2026-09-08 02:19:47 +08:00.
- Read 185 saved goodnight sessions and their text/image metadata. Compare only
  sessions with successful comic script and image artifacts; Shiori also needs
  a successful summary. Excluded incomplete sessions remain in the JSON report.
- Text model: `gpt-5.6-luna`. Image usage is reported separately from text usage,
  because tokens from different models/modalities are not equivalent prices.
- Primary text evidence: JSON `AI_USAGE` and `COMIC_SCRIPT_USAGE` records from
  `logs/pm2-combined-0*.log`, joined to recordings through shared-prefix keys and
  metadata. Request/response identifiers deduplicate records when available.
- Saved attempts supplement missing log records. The human-readable summary
  usage line is not a second request. Image attempt usage is counted once,
  without adding the same top-level metadata rollup again.
- 367 text artifact attempts matched log records. One extra completed goodnight
  request was found only in the log, preserving the known validation retry.
- The default comparison group contains 18 other rooms with the default
  100-character setting and filtered inputs. Sui and the three named target
  rooms are excluded from that group.

These are observed cross-recording results, not a matched same-source A/B test
or an exact forecast of the two target rooms after changing their settings.

## Current Settings

Verified with the production configuration loader as well as the JSON file.

| Room | ID | Reply Limit | Text Source | Extra Summary |
| --- | --- | ---: | --- | --- |
| Shiori | 26966466 | 250 | Full subtitles and merged danmaku | Enabled |
| Miting | 31368705 | 200 | Filtered highlights | Disabled |
| Mizuki | 30655190 | 100 | Filtered highlights | Disabled |

Shiori's experiment enables `goodnight`, `comic`, and `summary`, with
`summaryDeliveryMode=attach_if_ready`, `promptCacheRolloutPercent=100`,
`cachePropagationWaitMs=3000`, and the summary limited to one attempt and 2,000
output tokens. The 100% setting selects cache routing; it does not guarantee
that 100% of the input tokens hit a cache.

Default highlight selection is local processing in `do_fusion_summary.js`,
including the top 35% of danmaku-density windows and 10% sampling in low-energy
areas. It is not an additional paid LLM summary request omitted from this table.
ASR, clip selection and video generation are outside the requested workflow.

## Per-Recording Means

All numbers are tokens, rounded to the nearest integer. Text total includes
input plus output for goodnight, optional summary and comic script. Reasoning
tokens are already part of output and are not added a second time.

| Group | Complete Recordings | Text Input | Cached Input | Known Uncached Input | Text Output | Text Total | Image Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Shiori full | 9 | 361,559 | 98,446 | 263,112 | 5,679 | 367,238 | 9,597 |
| Miting filtered | 7 | 43,588 | 5,486 | 38,102 | 3,700 | 47,288 | 10,982 |
| Mizuki filtered | 15 | 39,716 | 3,584 | 36,132 | 4,057 | 43,773 | 10,802 |
| Other default rooms | 123 | 43,409 | 4,459 | 38,512-38,950 | 4,477 | 47,886 | 10,748 |

The default group's interval accounts for three comic requests with known input
but no cached-token count. It spans all-cached to all-uncached for just those
unclassified input tokens, not uncertainty about every request.

Counts are known lower bounds where failed calls did not return token usage:
Shiori has 3 such attempts, Miting 1, Mizuki 1, and the default group 12.
Unmapped unknown-usage logs cannot be assigned reliably and are not treated as
zero-cost calls. This is not an invoice reconciliation. Cached input is not
assumed free, and no gateway pricing multiplier or currency cost is inferred.

## Where the Increase Comes From

| Text Task | Shiori Input | Shiori Output | Default Input | Default Output |
| --- | ---: | ---: | ---: | ---: |
| Goodnight, including known retries | 130,038 | 588 | 22,815 | 553 |
| Extra live-content summary | 115,017 | 741 | Not requested | Not requested |
| Comic script | 116,504 | 4,351 | 20,593 | 3,924 |

The final goodnight bodies average 155 characters for Shiori, 128 for Miting,
97 for Mizuki and 93 for the default group. Despite the longer body, Shiori's
known goodnight output is only about 35 tokens per recording above the default
group. These output counts include reasoning and vary with content, so this is
not an isolated marginal-price estimate for the word-limit setting.

The extra summary alone averages 115,757 input-plus-output tokens per recording,
or 2.4 times the default group's entire goodnight-plus-script text workflow.
Its output is short, but it still reads the full stream.

Actual Shiori cache behavior across known completed requests:

- Summary: 8 of 9 requests report zero cached tokens; the other reports 3,840.
  None shows a large full-context cache hit.
- Comic script: 7 of 9 show a large cache hit; 2 report zero cached input.
- Aggregate text input cache hit share: 27.2%, not 100%.

Thus a cheap cached comic request does not compensate for the first full-context
goodnight request and the usually uncached full-context summary request.

## Robustness Checks

### Recent Recordings

Using only 2026-09-05 through 2026-09-07 produces the same decision.

| Group | Recordings | Mean Text Total | Mean Known Uncached Input | Mean Image Total |
| --- | ---: | ---: | ---: | ---: |
| Shiori | 6 | 354,629 | 240,943 | 10,669 |
| Miting | 3 | 56,917 | 46,601 | 9,136 |
| Mizuki | 6 | 49,570 | 41,421 | 10,696 |
| Other default rooms | 52 | 52,896 | 42,274-43,311 | 10,402 |

### Duration

All complete sessions above have ASR `mediaDurationSeconds` metadata. Aggregate
text tokens divided by aggregate recording hours are:

| Group | Mean Recording Hours | Text Tokens per Recording Hour |
| --- | ---: | ---: |
| Shiori | 1.93 | 190,007 |
| Miting | 3.59 | 13,178 |
| Mizuki | 3.19 | 13,735 |
| Other default rooms | 3.28 | 14,608 |

Shiori's sample is not more expensive because it contains longer streams.
Duration normalization still does not control speech density, content or
speaker-review transcript differences, so these ratios are observations, not
causal mode-only multipliers.

### Known Validation Retry

The 2026-09-07 Shiori afternoon recording contains a known unnecessary goodnight
rewrite: 118,690 input tokens, including 117,504 cached, and 663 output tokens.
Removing that historical call from the arithmetic reduces the weekly Shiori
mean to 353,976 text tokens and 262,981 uncached input tokens. The conclusion
does not change. This subtraction is not a prediction of downstream cache
behavior after removing a request, nor a refund of historical usage.

## Verification and Follow-Up

An independent read of the final metadata plus the additional logged first
goodnight request reproduces input, output and cached totals for all 31 complete
target-room sessions. Per-request arithmetic and reasoning-subset checks pass.
Shiori has 10 known completed goodnight calls, 9 summaries, 9 comic scripts and
9 image requests; summary and image rollups are not double-counted.

Only audit files were added. The audit uses local files and makes no network
requests. Existing application code was not changed, so no application build or
full test suite was run.

Potential lower-cost follow-up: increase only the reply limits while keeping
filtered inputs, or separately investigate reuse of one full-context request
for both the reply and summary. Neither change is part of this audit, and neither
has a measured quality or billing result here.

Local reproduction: `node tmp/audit-room-generation-tokens-20260908.cjs`.
Frozen evidence: `tmp/room-generation-tokens-20260908.json`, containing log
snapshot hashes, per-recording requests, evidence paths/line numbers, excluded
sessions, group totals and duration-normalized results. Re-running while the
production workers are active can include newly completed artifacts for these
recording dates and will create a newer snapshot.
