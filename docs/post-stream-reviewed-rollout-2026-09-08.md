# Reviewed Full-Input Rollout

## Decision and Current State

The selected production recipe is `compact_full_reply_summary_reviewed_v1`.
It is enabled only for Miting (`31368705`) and Mizuki (`30655190`) through
`ai.roomSettings.<room>.fullLiveContextExperiment.replySummary.enabled`.
Both keep the 250-character reply limit, full-source comic generation, live
overview, existing image model/routes and existing delivery settings.

Sui (`25788785`) and Shiori (`26966466`) are unchanged reference rooms. Their
room configurations and the global text/image configuration hashes match the
pre-rollout snapshot. New processing workers use the recipe; already-running
workers may retain their startup configuration. The webhook remains online in
this checkout and was not restarted. No experiment was posted to Bilibili or
registered in an upload queue.

This supersedes the temporary full-only rollout and the exploratory options in
`goodnight-full-rollout-experiment-2026-09-08.md` and
`goodnight-input-options-2026-09-08.md`.

## Selected Recipe

1. Preserve the entire parsed subtitle content and every audience message after
   the existing 30-second identical-message merge. Group only adjacent text with
   the same speaker label, reduce repeated timing/label formatting, and assign
   stable T/D evidence IDs. Keep the exact source locations in the JSON sidecar.
   Do not select only popular windows or discard the quiet/later parts.
2. Luna reads the compact full source once and returns the goodnight reply,
   overview and citations together. This replaces separate full-input reply and
   overview calls. The overview is not an exhaustive song list.
3. Validate output length, enums, evidence IDs, named-activity corroboration and
   source attribution. A small Luna review reads original context around cited
   evidence, checking conditional/negative wording, temporal meaning and actors.
   Its scope is the cited reply claims and named activities, not unseen topics.
4. The comic script independently reads the same complete compact prefix and
   the accepted overview. It retains the existing native storyboard, reference
   screenshot and image-generation pipeline. Existing control/immersive rollout
   proportions are unchanged.

There are normally three text calls: combined reply/overview, short evidence
review, and comic script. Only two read the full source. All use Luna/high.
The image call remains separate. Prompt cache can still be reused by the two
full-source calls, but the saving does not require a cache hit.

The compact form removes repeated metadata formatting, not spoken words or
audience content. It keeps speaker labels and source indices, rather than
claiming acoustic labels prove identity. If source timing cannot be represented
without dropping speech, it uses the original full format and existing path.

## Why This Combination

Earlier experiments established concrete shortcomings:

- Pure popularity filtering can discard the setup or ending of quiet topics.
- A speech-only scout reduced costs sharply but lost the later game and quiet
  anniversary discussion in one recording, and misidentified a lyric as a title.
- Combining all three outputs was cheap, but coupled story/actor errors and
  delayed all outputs until the comic script completed.
- Requiring the model to reproduce exact quotes introduced ASR-spelling and
  audience/speech attribution errors. Stable IDs let code retrieve the originals.
- A partial-source reviewer incorrectly removed genuine uncited topics. The
  final reviewer is explicitly scoped; it cannot discard topics simply because
  they are outside its excerpts. Overview changes require an activity correction.
- A review invented `watch_video`. The final prompt enumerates valid values and
  the parser rejects unknown values rather than silently accepting them.

ID linkage proves provenance, not semantic truth. Unknown speaker identity is
retained as uncertainty; the model review and room-specific source rules are
additional checks, not a guarantee that every future claim is correct.

## Completed Comparisons

After the earlier three-recording text study, two additional recordings were
run through actual text generation, the existing Python comic pipeline, source
screenshots and `gpt-image-2`. Both arms used the same chosen SRT/XML and control
storyboard style. The new arm uses the new grounding rules as part of the recipe.

- M2: Miting's September 6 afternoon animation-viewing session.
- Z3: Mizuki's September 6 afternoon chat, singing and video-viewing session.

The following values use reported tokens and the official September 8 pricing,
not the local gateway's account deduction. Image input is priced as uncached.

| Recording | Full Separate Text | Final Recipe Text | Full Text + Image | Final Recipe Text + Image |
| --- | ---: | ---: | ---: | ---: |
| M2 | $0.09646 | $0.05636 | $0.22350 | $0.15419 |
| Z3 | $0.06284 | $0.05626 | $0.19231 | $0.16677 |

The text component is about 42% and 10% lower respectively. The nominal completed
workflow is about 31% and 13% lower. Across the two, nominal text saving is about
29%, and nominal text-plus-image saving about 23%.

Do not interpret image-token variation as a guaranteed result of text packing:
the image route and requested quality were held constant, but the service
returned different layouts and token counts. These are two completed examples,
not statistical non-inferiority or a universal savings rate.

### All Observed Costs

Z3 also incurred a superseded review-format attempt costing $0.00688. It is
retained in the experiment ledger, not erased. Including it, the observed known
Z3 text-plus-image total was $0.17365, about 10% below its baseline.

The first M2 candidate image returned HTTP 502 with no usage. Its request ID,
`235f7157-068e-435e-8d33-0fd2e5bdc60b`, and metadata were saved before retrying the
image only. The second attempt succeeded without regenerating reply, overview
or script. The failed image fee is unknown, not zero. Consequently this report
does not claim a complete account-bill comparison including that failure.

The four completed comparison workflows plus the known development review cost
sum to $0.74365, with the failed image charge unknown. A separate immersive
compatibility run added $0.02516 of script tokens and $0.08444 of image tokens,
reusing the already-generated reply and overview. These sums cover the final
comparison stage, not every earlier exploratory run.

Pricing: text Luna input/cache-read/cache-write/output is
$0.20/$0.02/$0.25/$1.20 per million tokens. Image-2 image input/text input/image
output is $8/$5/$30 per million. Long-context multipliers are applied where
relevant. Current sources:
[Pricing](https://developers.openai.com/api/docs/pricing),
[Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[Image-2](https://developers.openai.com/api/docs/models/gpt-image-2).

## Quality and Visual Checks

The tested new results retained the full-source activity distinctions: watching
the animation rather than playing it in M2, and watching game footage rather
than personally playing it in Z3. M2's new reply also used the source-supported
silver-key wording where the baseline reply misread the object name.

All four paired comparison images were opened and inspected. They are nonblank,
legible and retain the room character/reference identity, with no obvious new
image regression found in this small comparison. This is source-backed assistant
inspection, not independent human blind scoring or proof that all details are
perfect. Human observation of formal results remains the intended next step.

One additional immersive image was generated and inspected: 4 storyboard beats,
3 reference requests, valid metadata, 1024x1536 output. It confirms compatibility
with the other production style, not a paired quality ranking for that style.

The main tradeoff is latency. The first reply is now held until the combined
generation and short review complete, typically taking minutes in these tests
rather than the roughly 12-second standalone baseline reply. Images and the
existing delayed-publication flow continue afterward. This recipe prioritizes
complete material and bounded checks over the fastest possible first draft.

## Runtime Guarantees

- A canonical `*_REPLY_SUMMARY.json` stores the draft, accepted output, review,
  source fingerprint, request IDs, phase timings and all recorded attempts.
- `*_LIVE_CONTENT.json` references that shared usage. It is reused by the
  existing overview consumer without another full-source request.
- Goodnight Markdown remains compatible with the existing delivery path. New
  metadata includes request/response IDs and shared usage ownership. Rejected
  drafts now retain their attempt metadata for cost accounting as well.
- Existing replies and summaries are not overwritten. A committed result can
  restore missing derivatives without a new model call. Output installation
  avoids exposing a partially written reply or summary.
- Concurrent generation locks prevent duplicate writers. Unknown/queued or
  ambiguous transport outcomes stop further AI generation for that recording.
  They are not blindly resubmitted or treated as free failures.
- Definitive validation/transport failures may use the existing separate full
  path. Failed combined attempts remain in the ledger. The same terminal failed
  recipe is not repeatedly retried; a revised review can reuse a completed draft.
- The source prefix and sidecar are byte-equivalent to the old implementation
  when the new format is disabled. Reference-room behavior is not globally changed.

## Manual Observation

Run from the repository:

```powershell
npm run poststream:usage -- --output data/runtime/post-stream-usage-latest.json
```

Optional recording-date bounds:

```powershell
npm run poststream:usage -- --since 2026-09-08 --until 2026-09-15 --output data/runtime/post-stream-usage-latest.json
```

The default rooms are Sui, Shiori, Mizuki and Miting. The default root is the
configured active recording root; `--root` can inspect an archive with the same
room/date layout. Dates refer to recording directories, not log rotation dates.

The terminal shows ready/total records, known input/cache/output tokens, separate
text/image price equivalents and unknown accounting. The JSON includes per-record
mode, reply, overview, output paths, request IDs and phase data. Shared calls are
deduplicated; failed recordings without a reply are not omitted from costs.

Older diagnostics that did not save usage are explicitly unknown. The report
does not equate missing usage, incomplete output or unsupported model pricing
with a free request, and it is not an invoice reconciliation.

Rollback for future tasks is the two `replySummary.enabled` flags only. Keep
the existing full-context experiment if returning to the Shiori-style separate
flow. Do not use a flag change as permission to resubmit an unresolved old API
request; inspect its ledger and provider state first.

## Verification

- 93 Jest suites / 1,042 tests passed, including source preservation, shared
  publication/recovery, unknown outcomes, attribution checks and cache behavior.
- 8 Python usage-report tests passed. The four-room report was run successfully.
- Type-check and build-check passed. Architecture check retains only the two
  pre-existing ASR line-budget failures in `audio_processor.js` and
  `python/sensevoice_speaker.py`; neither file was changed for this goal.
- Five actual images were decoded, pixel-variance checked and visually inspected.
- JavaScript and Python production config loaders confirm the two-room rollout.
  The running webhook uses this checkout; its worker launches the updated source
  script, so no compiled release activation or service restart was required.

Evidence: `tmp/goodnight-final-20260908/RESULTS.json`, its per-arm `PILOT.json`,
canonical/text/image metadata, source snapshots, prompts and images; earlier
iterations are retained in `tmp/goodnight-paired-20260908/` and
`tmp/goodnight-ab-20260908/`. No failed draft or earlier cost was retroactively
reclassified as a successful request.

## Image Comparisons

[Miting baseline](D:/workspace/myrepo/danmaku-to-summary-ts/tmp/goodnight-final-20260908/M2/full/录制-31368705-20260906-140842-312-「古诺西亚」_COMIC_FACTORY.png)
and [Miting selected recipe](D:/workspace/myrepo/danmaku-to-summary-ts/tmp/goodnight-final-20260908/M2/paired/录制-31368705-20260906-140842-312-「古诺西亚」_COMIC_FACTORY.png).

[Mizuki baseline](D:/workspace/myrepo/danmaku-to-summary-ts/tmp/goodnight-final-20260908/Z3/full/录制-30655190-20260906-150336-054-虚度一小点⭐_COMIC_FACTORY.png)
and [Mizuki selected recipe](D:/workspace/myrepo/danmaku-to-summary-ts/tmp/goodnight-final-20260908/Z3/paired/录制-30655190-20260906-150336-054-虚度一小点⭐_COMIC_FACTORY.png).

[Immersive compatibility image](D:/workspace/myrepo/danmaku-to-summary-ts/tmp/goodnight-final-20260908/M2/paired-immersive/录制-31368705-20260906-140842-312-「古诺西亚」_COMIC_FACTORY.png).
