# Goodnight Input Options and Cost

## Recommendation

The earlier token comparison remains correct, but token growth alone does not
establish that full-context mode is unaffordable. At the current official Luna
rates, enabling the existing full experiment for only Miting and Mizuki is a
reasonable short-term option, subject to the gateway's actual billing and an
explicit rollout decision.

For the narrower objective of improving goodnight material, start with
**full-context goodnight only**, leaving comic input filtered and not creating
an extra summary. This combination is already supported by the task flags.
It removes the heat-filter blind spot for the reply without building a new
selection system first. It does not improve the comic's selection, and the
reply and image may choose different events.

For a reusable solution across many rooms, investigate **one compact full-speech
selection pass, then source-grounded material reuse**. Do not solve the problem
solely by adding more popularity keywords, random sampling, or embedding search
over an already filtered subset.

This document is research, not rollout authorization. No production settings,
generated replies, images, queues or publication records were changed. No paid
model call was made during this research.

## Existing Limitation

`src/scripts/do_fusion_summary.js` keeps subtitles from the top 35% of
30-second danmaku-density windows, selected future/closing keywords, and a random
10% of other subtitle lines. Low-reaction conversational stories can lose their
setup or ending before the language model sees them. A stronger final model
cannot evaluate evidence that has already been discarded.

Quiet but specific personal details, a self-deprecating remark, a sustained
conversation or a caring closing note can be good reply material without being
the most popular or most independently publishable clip. Goodnight selection
should optimize for that objective, not import clip rankings unchanged.

Reading all available speech at least once is the direct way to let an AI judge
quiet passages. Chunking with the same model does not by itself reduce aggregate
input tokens; overlaps, repeated instructions and extra reasoning can increase
them. The savings should come from compact representation and avoiding repeated
full-source reads, not a claim that chunking makes text free.

## Verified Price Reference

Fetched on 2026-09-08:

- [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
- [GPT-5.6 Luna model details](https://developers.openai.com/api/docs/models/gpt-5.6-luna)

Standard USD per million tokens: uncached input $0.20, cache read $0.02,
cache write $0.25, output $1.20. Reasoning is part of output, not an additional
charge. Above 272,000 input tokens in one request, the model page specifies
2x input and 1.5x output pricing for the entire request.

The configured primary route is the local Sub2API gateway. Its public page
does not expose account billing, and there is no signed-in browser session for
the account. Actual gateway multipliers, package/subscription treatment and
deductions were not verified. These are official-price equivalents, not the
user's invoice. Fallback-model fees and failures with unknown usage remain
outside the estimates.

The prior observed complete-session means convert to approximately $0.0614 for
Shiori's text workflow, $0.0122 for Miting, $0.0122 for Mizuki, and $0.0133 for
the other default rooms. Thus the original comparison describes a large token
ratio but only about five US cents of incremental text cost per Shiori-like
recording at these rates.

## Offline Input Measurement

Read the actual primary `.srt` and matching `.xml` files for 10 Miting and 17
Mizuki recordings dated September 1-7. All 27 had the required sources. Also
measured Shiori's nine recordings for reference. Existing source parsers and
`buildSubtitleEvidence` were reused. `tiktoken` 0.14.0 resolves Luna to
`o200k_base`; results below are local source-token estimates, not new API usage.

| Source Representation | Miting Mean Tokens | Mizuki Mean Tokens |
| --- | ---: | ---: |
| Existing full-context prefix format | 121,324 | 125,912 |
| Compact full speech plus all merged danmaku text | 65,989 | 71,603 |
| Compact full speech plus sparse audience counts | 36,532 | 29,849 |

The compact forms retain every subtitle body from the selected SRT. Repeated
speaker labels and confidence strings are placed in a dictionary; consecutive
same-label segments are grouped, without crossing speaker changes, long gaps
or the group-size bound. Exact source segments and times remain recoverable
locally through evidence IDs. No words are rewritten by another model.

The second row retains all existing 30-second-merged danmaku text, but represents
times at bucket precision and omits the verbose heat/emotion tables. It is
approximately 43-46% smaller, not a completely lossless metadata encoding.

The third row retains all speech but only audience-count statistics in the
selection input. Actual audience quotes would be fetched for the selected
windows afterward. It is approximately 70-76% smaller than the original full
prefix, but is not equivalent to letting the selector inspect every audience
message. Rare audience-led jokes remain a recall risk; a small separate
audience-candidate channel or local follow-up retrieval should address that.

Speaker-review SRTs were measured separately where present, not silently
substituted for the primary SRT. Their compact-scout means are 53,324 tokens for
Miting and 43,548 for Mizuki, so compacting is useful even when richer speaker
attribution is required. One Mizuki speaker-review full prefix exceeds the
272K pricing threshold. Source choice must be logged and quality-tested,
especially for multi-person streams; anonymous speakers must not become the host.

## Cost Scenarios

These scenarios use the primary SRT, unchanged image frequency, and illustrative
task overhead/output budgets. Full-context scenarios budget three requests with
4,200/1,000/5,000 overhead input tokens and 700/800/5,000 output tokens for
goodnight, summary and comic script. Cache scenarios range from one full-prefix
hit on the comic request to no hits. They are not measured cache guarantees.

| Option | Miting Text USD per Recording | Mizuki Text USD per Recording | Engineering |
| --- | ---: | ---: | --- |
| Current filtered mode, observed complete sessions | 0.0122 | 0.0122 | None |
| Existing full experiment, one prefix hit to fully cold | 0.0608-0.0826 | 0.0627-0.0854 | Room settings |
| Full-context goodnight only, current comic input | 0.0338 | 0.0347 | Room task flags |
| Compact speech and all audience text, still three calls | 0.0494 | 0.0528 | New source representation |
| One compact speech scout plus reused evidence pack | 0.0219 | 0.0205 | Selection artifact and integration |

The scout scenario budgets a 2,500-token instruction and 2,500-token output,
followed by a 6,000-token evidence pack for each downstream task. Goodnight and
comic instructions/output are as above. The brief overview comes from the scout;
there is no second full-input summary call. The total input budget is roughly
60K for Miting and 54K for Mizuki before output, versus around 374K/388K for
three original full-prefix requests. Real selected packs and reasoning usage
must be measured before treating these as production limits.

At 10+17 recordings per week, a 30-day month extrapolates to about 116 recordings.
Assuming every recording takes the modeled path, the combined incremental text
cost versus the observed default complete-session means is approximately:

| Option | Incremental USD per 30 Days | Illustrative CNY at 7 CNY/USD |
| --- | ---: | ---: |
| Original full experiment | 5.77-8.35 | 40-58 |
| Goodnight full only | 2.57 | 18 |
| Compact scout and source reuse | 1.03 | 7 |

This is a planning envelope using observed cadence, not a monthly forecast or
exchange-rate quote. Some recordings currently skip or fail image/script
generation; the all-complete assumption avoids claiming those paths always run.
Richer speaker sources, longer future streams, retries and gateway multipliers
can increase the estimate. Image model costs are excluded and are not newly
saved by a text-only optimization.

## Proposed Reuse Design

1. Build a compact, source-indexed transcript from the entire chosen SRT. Keep
   known and unknown speaker identities separate and preserve words, negations,
   attribution and original source mappings. Add title/time context and a small
   audience signal channel. Do not remove all songs, gifts or ordinary chat by
   category; judge their usefulness for this reply.
2. Ask Luna once for a short stream overview and up to 6-10 distinct reply-worthy
   moments. Require source cue IDs, the event's subject, a brief reason and
   attribution type. Specifically invite quiet content-driven moments; audience
   heat is supporting evidence, not the primary rank. Do not require a quota of
   weak moments, a point from every time bin, or a fixed number of anecdotes.
3. Resolve the IDs locally. Fetch the setup, relevant speech, reaction and ending
   from original SRT, plus actual neighboring XML quotes. Keep source snapshots
   and hashes. Reject unknown/out-of-range IDs and incomplete evidence. Exact
   quote linkage proves provenance, not that the ASR or interpretation is true.
4. Generate the goodnight reply from the best 2-4 appropriate moments with their
   evidence. Give comic generation the same fact pack, with any needed wider
   event context. Use the scout's short overview for the existing overview
   delivery contract, after schema validation. Never repeatedly summarize a
   summary until all concrete speech is lost.
5. Cache the prepared material by room, source hash, prompt version, model and
   selection settings. Reuse that artifact for downstream requests and retries.
   This avoids new requests even when provider prompt-cache routing misses.
6. For long sources, split on evidence boundaries and scan every chunk within a
   documented budget, then globally compare grounded candidates. If the budget
   cannot cover the source, report partial coverage or use the current fallback;
   do not silently truncate the tail and call it full-transcript selection.

Keep the initial implementation independent of media cutting and upload queues.
The existing subtitle-evidence IDs and chunk packing can be reused, but the
50-clip publication workflow and its full output schema are unnecessary here.
For streams where a trusted full-transcript selection artifact already exists,
reuse its grounded candidates when the source hash matches; do not wait for
video rendering to prepare a goodnight reply.

## What to Validate Next

Compare current filtered replies, full-goodnight-only replies and compact-scout
replies on a small isolated sample from each room: quiet chat, song chat, solo
game, multi-speaker game and unusually long streams. Use the same final writer
and word limit so the comparison tests material rather than style changes.

Judge concrete event choice, quiet-topic recall, intact setup/ending, factual
attribution, natural comment quality, total known cost and end-to-end delay.
Have a reviewer mark useful moments from the complete source before reading
which system selected them. Reject unsupported claims or speaker swaps; do not
accept them merely because a lower-cost method returns more moments. Neither
full context nor the prototype currently has measured superiority on this set.

An initial rollout should be limited to these two rooms, keep the existing
fallback, and record cost and latency per recording. It should have explicit
budget/timeout limits and preserve unknown-outcome safeguards, with no automatic
extra audit model or repeated full-prefix retries.

Only local input retention, grouping and token volume were verified here. The
prototype made zero paid model requests. Practical next step: try the existing
goodnight-only full-input path first; use the more involved reuse design when
the measured quality benefit or wider-room rollout justifies its maintenance.

Research script: `tmp/research-goodnight-input-20260908.cjs`.
Measurements: `tmp/goodnight-input-research-20260908.json`.
Baseline: `tmp/room-generation-tokens-20260908.json`.
