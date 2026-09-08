# Full-Context Rollout and Optimization Experiment

Follow-up: the selected reviewed compact recipe is now enabled for Miting and
Mizuki. See `post-stream-reviewed-rollout-2026-09-08.md` for the current production
state, completed image comparisons and manual usage reporting. The observations
below remain the earlier experiment's historical record.

## Production State

On 2026-09-08, the user explicitly authorized enabling the complete Shiori mode
for Miting (`31368705`) and Mizuki (`30655190`) and running isolated experiments.
The earlier decision not to roll out based on token ratios is superseded by
this authorization and the subsequent absolute-cost analysis.

`config/production.json` now gives both rooms:

- A 250-character goodnight limit.
- `fullLiveContextExperiment.enabled=true`, tasks `goodnight`, `comic`, `summary`.
- The same Luna model, cache rollout, 3-second propagation wait, summary delivery,
  timeout, attempt limit and cooldown as Shiori.
- `preferSpeakerReviewSrtWhenMultipleSpeakers=true`, matching Shiori's source
  attribution safeguard. Actual source selection still depends on available
  speaker results; this does not force every recording to have multiple speakers.

Existing host/fan names, reference images, room content hints and other settings
were preserved. A configuration hash excluding only the three changed fields in
the two rooms was identical before and after editing. Both the JavaScript and
Python production loaders return the new settings.

New summary workers are spawned with `NODE_ENV=production` and read the JSON
configuration at startup. No build activation or service restart was necessary;
running workers and existing published artifacts were not interrupted or rerun.
This verifies configuration availability for new tasks, not a claim that a new
post-rollout production recording has already completed.

No experimental optimization below was enabled in production.

## Can the Tasks Share Cache?

Yes. Goodnight, overview and comic-script requests use the same text model and
can share the same recording prefix. The saved experiment requests confirm a
byte-identical prefix, system instruction, role layout and routing key across
these three stages. `promptCacheRolloutPercent=100` selects cache routing for
every eligible request; it does not mean a guaranteed cache hit.

The image-rendering request is a different model and multimodal input. It does
not inherit Luna's text-prefix cache. This distinction applies throughout the
cost comparison below.

Two production-format observations from the experiment:

| Case / Text Request | Input | Cached Input | Cache Share | Official-Price Equivalent |
| --- | ---: | ---: | ---: | ---: |
| Z2 full goodnight | 173,228 | 0 | 0% | $0.03541 |
| Z2 full summary | 171,724 | 0 | 0% | $0.03511 |
| Z2 full comic script | 173,803 | 170,752 | 98.2% | $0.00586 |
| Z1 compact comic script | 165,984 | 163,584 | 98.6% | $0.00682 |

The Z2 comic would cost approximately $0.03660 at the same usage without caching,
so that call saved about 84%. The entire Z2 full workflow saved about 29%, because
its goodnight and summary still read cold. M1 and Z1 full workflows had no cache
hits in this run; all nine full-mode requests together cached 10.7% of input.

### Transport Probes

A separate six-request small-prefix test compared replacing the task suffix
with extending the prior conversation, including a same-request repeat:

| Request | Replace Task Suffix | Append Conversation Turn |
| --- | ---: | ---: |
| First request cached tokens | 0 | 0 |
| Different second task cached tokens | 2,816 / 3,719 | 0 / 3,757 |
| Repeat second task cached tokens | 2,816 / 3,719 | 2,816 / 3,757 |

Appending turns did not demonstrate an improvement. Different prefixes/routing
keys and the small sample prevent a causal ranking of transport shapes.

One explicit-breakpoint request returned HTTP 400:
`prompt_cache_breakpoint is not supported on this model`.
Request ID: `ceef1399-6402-4931-bb64-baddf6703e3d`.
It was not retried without the rejected parameter. No usage was returned, so
it remains a billing-unknown request rather than being asserted free.

Official documentation supports explicit cache controls for GPT-5.6-family API
models, but the current gateway rejected this control. A key influences routing;
it does not pin the request to a cache machine or override compatibility limits.
The existing implicit request format was therefore left unchanged.

Sources fetched 2026-09-08:
[Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[Luna model](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[Pricing](https://developers.openai.com/api/docs/pricing).

## Comparison Design

Three whole recordings from September 7:

- M1: Miting, evening song/chat stream, speaker-review SRT.
- Z1: Mizuki, evening audience-submission reading, primary SRT.
- Z2: Mizuki, afternoon multiplayer game and later solo game, speaker-review SRT.

Five arms were run once per recording, yielding 36 successful content-generation
requests and 15 completed arm outputs:

1. `filtered`: saved default highlight input; goodnight and comic, no summary.
2. `full`: original full prefix; separate goodnight, summary and comic calls.
3. `compact`: all subtitle bodies and all merged audience text retained, compact
   metadata/timing representation; the same three generation tasks.
4. `scout`: one full-speech selection pass with audience counts, then original
   selected source windows and neighboring audience text reused downstream.
5. `joint`: one original-full-source request produces goodnight, summary and
   comic script together in separate JSON fields.

Full, compact, scout and joint share the same SRT per recording. The filtered
arm is the real saved default-input reference, not a matched regeneration from
the speaker-review source. This distinction prevents attributing its differences
solely to text packing.

The writer is Luna/high, with the same 250-character reply rules, deterministic
prompt-variant choice and control-style comic rules. Joint generation includes
an outer JSON transport instruction and additional cross-field consistency
guidance, so its treatment changes task organization as well as read count.
The joint prefix has an arm-specific header to avoid claiming cache warmed by
the full arm as its intrinsic saving.

No model/provider fallback or automatic retry was used. Failed or unknown
outcomes were not resubmitted. Provider calls, prompts, IDs, timestamps, usage,
source hashes and text are retained in the isolated experiment directory.

## Measured Cost

Means per recording, across these three cases. Prices use reported usage and
current official standard USD rates, not verified gateway account deductions.

| Arm | Input Tokens | Output Tokens, Including Reasoning | USD per Recording | Saving vs Full | USD with All Input Cold |
| --- | ---: | ---: | ---: | ---: | ---: |
| Filtered reference | 40,349 | 2,654 | $0.01125 | Not equivalent feature set | $0.01125 |
| Full, three requests | 532,224 | 4,869 | $0.10204 | Reference | $0.11229 |
| Compact, three requests | 337,918 | 5,446 | $0.05897 | 42.2% | $0.07412 |
| Scout and source reuse | 76,722 | 9,287 | $0.02649 | 74.0% | $0.02649 |
| Joint full-source request | 180,220 | 3,956 | $0.04079 | 60.0% | $0.04079 |

The all-cold column holds each arm's observed token counts fixed and removes
cache discounts; it is an arithmetic sensitivity case, not a second measured
run. Joint still saves 63.7% against cold full-mode usage, independently of cache
luck in this sample. Scout saves more input but needs additional reasoning and
has the quality gaps described below.

These three selected recordings are not the nine-recording Shiori average from
the earlier audit, nor a random monthly workload sample. Do not apply the new
per-recording mean to every room as a fixed multiplier.

### Latency Tradeoff

Summed request elapsed time per recording averages 105s for full, 142s for
compact, 207s for scout, and 89s for joint. These numbers exclude image rendering,
queue wait and most local preparation, and are not production P95 measurements.

More importantly, full-mode goodnight alone completed in 12.2-13.3s. Joint
outputs arrived together after 66.3-105.2s. It can save tokens while delaying the
first ready reply, and a joint failure can withhold all three outputs. In two
of these cases joint was slower than the complete separate text workflow; the
aggregate advantage was driven by M1's unusually slow standalone summary.

## Quality Findings

All 15 outputs completed generation; this is not a quality-pass claim. No
optimization met a demonstrated non-inferiority gate in this pilot.

| Arm | Useful Observation | Blocking or Unresolved Risk |
| --- | --- | --- |
| Full | Miting reply recalls singing-specific jokes; Mizuki game summary identifies the later second game | Still invents or assumes some physical screenshot details |
| Compact | Preserves original speech and supports a 98% large-prefix cache hit | M1 summary promotes discussion of World of Warcraft to actual gameplay, then comic depicts a battle UI |
| Scout | Recovers calm dream/reading discussion at low downstream input cost | M1 treats a lyric as a song title; Z2 loses the late second-game sequence and anniversary chat |
| Joint | Preserves full speech/audience coverage and generated correct activity lists in the tested cases | Z2 reply attributes team teaching/healing to the host without sufficient actor evidence; delayed first reply |

Specific checked evidence:

- M1 `G970`, `G979`, `G986`, `G989`, `G998`: hunter-build discussion, including an
  explicit reference to changing skills yesterday. The compact comic's proposed
  4860s battle screenshot instead shows a virtual avatar singing. This proves
  that requested frame does not support the scene; the entire recording was not
  visually exhaustively reviewed.
- M1 `G496`, `G501`, `G508`: scout promotes a lyric phrase to a title. Full/joint
  identify the corresponding song as Yu Ai; dropping audience text from the
  initial selector removes one useful corroboration channel.
- Z2 `G1399` and `G3203` mention the later game with ASR spelling variation;
  full/compact/joint recover its name. Scout's pack ends at 9827.5s and omits the
  later game action and anniversary discussion at `G3659`-`G3677`, despite having
  received all original speech. Full input coverage does not guarantee recall.
- Z2 `G44` shows the likely host channel asking a teacher about equipment;
  `G3177` has a different speaker ending the class. The joint reply's host-as-
  teacher/healer claim is unsupported. This is not proof of every player's exact
  identity or role; those need stronger speaker/context evidence.
- M1 at 700s shows a virtual avatar and chat, not a camera view under a physical
  desk. Several arms ask that frame to verify an off-screen object layout. The
  spoken event may inspire an illustration, but the physical layout is not
  visually verified. This weakness also appears in the unoptimized baseline.

### Evaluation Limits

Sol/high first produced independent reference-event annotations for all three
complete sources, before seeing candidate outputs. Two later label-blind
five-arm scoring requests timed out at 300s without usage. They were not rerun.
No completed blind score table or averaged quality score is claimed.

The final quality findings are source-backed assistant verification, supported
by those preliminary annotations and three extracted recording frames. Model
annotations are not ground truth: for example, the M1 reference caution about
not mentioning next-day training is too restrictive because `G1935` explicitly
mentions the Tuesday training schedule.

Prototype gaps are retained rather than hidden: M1 scout returned three
`sourceKind=singing` values outside its requested enum; its consumer checked IDs
and time bounds but did not reject that enum violation. Z2 scout's overlong
overview was truncated mid-sentence by normalization. Neither a parseable JSON
object nor valid cue IDs establish factual correctness.

No generated images were rendered or published in the experiment. Since script
and material issues already fail the quality gate, image-generation spending
was deferred. These findings concern text/script content and reference planning,
not actual rendered-image quality.

## Experiment Spend and Verification

- Content-generation requests: $0.71865 known official-price equivalent.
- Three completed reference-annotation requests: $1.69947.
- Six completed small cache probes: $0.00302.
- Known total: **$2.42114**, plus unknown usage from two review timeouts and one
  rejected explicit-cache request. Unknown is not zero and this is not an
  account-billing reconciliation. No further paid requests were added.
- Three generation requests reported output token counts above their requested
  limits, including a 2,000-token summary request returning 8,119 output tokens.
  Reported usage, not the requested cap, was used for cost calculation.
- Six relevant Jest suites / 60 tests passed for goodnight, summary, scheduling
  and cache request construction. JavaScript and Python config checks passed.
- Original SRT hashes remain unchanged. All recorded manual cue references and
  selected pack IDs resolve; generation response IDs are unique and token
  arithmetic passes. No queue entry, published reply or generated production
  image was changed by the experiment. All local experiment processes finished.

## Next Optimization Direction

Keep the user-authorized full-mode rollout while improving the cheaper alternatives
offline. The next bounded comparison should prioritize **joint full-source
generation with explicit source grounding**, because it avoids repeated full
reads without first restricting candidate recall or requiring cache hits.

Before considering production use:

1. Require source IDs and actor/source-kind evidence for chosen events and
   activity names. Validate all enums and source bounds; uncertain roles should
   remain team-level claims. Do not silently truncate generated summaries.
2. Resolve song/game names from nearby speech and original audience evidence;
   a mentioned game, point request or lyric fragment is not proof of a performed
   activity. Recheck output activity labels before they become comic constraints.
3. Separate scene inspiration from claims that a requested source frame shows
   the scene. Verify reference frames or keep unverified physical detail neutral.
4. Test a two-call variant joining only reply and overview, with a separately
   cached comic request, against the three-output joint variant. This variant
   has not been run here and may trade some savings for earlier reply delivery.
5. Repeat paired outputs on fresh recordings with quiet-topic and multi-speaker
   checks, explicit per-stage spend/timeout accounting and independent human
   review before asserting quality parity. A single stochastic sample per arm
   cannot establish it.

Artifacts: `tmp/goodnight-ab-20260908/results.json`, `manual-checks.json`, per-case
source/evidence/prompt/response files and frame checks. `run.cjs`, `joint.cjs`,
`review.cjs`, and `cache-probe.cjs` contain the isolated experiments. `analyze.cjs`
recomputes the report without new AI calls. Do not rerun a failed result under
the same identifier to guess whether the upstream request finished.
