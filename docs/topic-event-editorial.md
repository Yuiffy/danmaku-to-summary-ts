# Topic Clip Event Editing

The keyword workflow also supports a pre-render review path controlled by
`clipTopics.review.mode: "preflight"`. Its preparation, validation, and model
comparison are documented in [Preflight Comparison](topic-preflight-comparison-2026-09-07.md).
When that path is enabled it replaces the event/copy calls below, rather than
adding two shadow review calls after them. The legacy path remains available.

The keyword topic workflow now treats a publishable event, not a keyword hit or
an arbitrary duration, as the unit of selection. This applies to `clipTopics`;
own-stream and manual-queue selection keep their existing policies.

## Pipeline

1. Recall keyword bursts with the existing matching rules and context padding.
2. Pool overlapping context windows into bounded editorial requests. Pooling
   provides shared evidence; it does not itself merge the events. The complete
   audio-track subtitles are retained, with source cue IDs and available speaker
   labels, rather than taking the first N lines or sampling away a payoff.
3. Let the configured topic model choose independent events across each group.
   Combine the setup, development, reversal, and immediate host reaction to the
   same story into one continuous source interval. A new topic requires its own
   independently worthwhile clip, or is omitted. No existing MP4s are concatenated.
4. Resolve the returned cue IDs to exact source times. Reject unknown/out-of-range
   evidence, missing keyword anchors, invalid duration, and overlapping outputs.
   Never silently truncate the model's event to satisfy a duration limit.
5. Apply a final cross-group overlap safety check. Editorial score takes priority;
   duration is only a tie-breaker. Repeated keyword wording alone no longer deletes
   different non-overlapping events. Conflicting candidates remain in the plan for
   manual review, with a warning; this safety check is not a semantic merge.
6. Generate title, description, and two-line cover copy in a separate request for
   each locked final interval. Supply only its complete in-clip subtitle evidence,
   not recall titles, other events, or outside-context facts. Validate the clip ID,
   cited evidence, quoted text, numeric claims, and basic copy format.
7. Use the existing media/subtitle/cover pipeline, review, short-ID registration,
   and notification. No automatic upload authorization is added.

## Duration And Request Limits

The defaults in both JSON configs and config loaders are:

```json
{
  "preferredClipSeconds": 180,
  "maxClipSeconds": 480,
  "editorial": {
    "enabled": true,
    "maxGroupSeconds": 1800,
    "maxEvidenceChars": 80000
  }
}
```

Three minutes is a preference. A longer event must supply an `extensionReason`
explaining the necessary setup or payoff. Eight minutes is a hard ceiling, not a
target: if an event cannot fit, select a complete sub-event or leave it for review.
Explicit caller limits remain respected; do not override them per clip.

Request limits stop adjacent groups from growing indefinitely. An individual
oversized burst is not truncated to meet the evidence budget: it falls back to
recall windows marked for review. Successful event and final-copy responses use
the existing validated selection cache under the recording's mapped output-side
`temp/<source filename>/topic_selection` directory. Prompt or final-boundary
changes invalidate the relevant cache key.

## Attribution And Failure Handling

The recorded audio can include guests, retelling, quoted dialogue, and playback.
First-person speech is not proof that the host is the person in the story. Copy
must distinguish the host's reaction from events being recounted or watched.
Uncertain source attribution is marked `needs_review`; linked cue IDs prove a
time/provenance association, not that ASR identities or interpreted claims are true.

On model or validation failure, preserve the original recall windows with
`editorial.status: "fallback"` and a planning warning. Do not call a mechanical
union an editorial merge. If final copy fails, use neutral source/time templates,
mark `copyStatus: "fallback"`, and retain the failure. Never reuse old candidate
copy for changed boundaries.

`<recording>_TOPIC_PLAN.json` records the source hash, grouped keyword anchors,
selected and suppressed candidates, editorial assessments, linked evidence,
request diagnostics, and failures. Per-clip metadata records `editorial`, final
copy grounding, the copy model, and its locked `copyWindow`. `REVIEW.md` links the
plan and exposes long-event and attribution review notes. All results still need
the existing human approval before upload.

Set `clipTopics.editorial.enabled` to `false` to use legacy per-burst AI planning.
Disabling AI text or `aiSegmentBurst` still uses the existing rule-based path.
These switches do not independently restore the former 180-second hard ceiling.

## Regression Case

Mofu's 2026-09-06 recording produced `[6743, 6923]`, `[6849, 7029]`, and
`[7015, 7168.814]`. The 74- and 14-second overlaps crossed a story, a reversal,
the host's reaction, and a subsequent topic. Simply removing the middle clip lost
unique story development. Tests now require joint consideration, preservation
of the reversal in a longer continuous event, a separately bounded new topic,
and fresh copy based on the respective final intervals.

```powershell
npm test -- --runInBand src/scripts/clipping/topic_editorial.test.ts src/scripts/clipping/topic_selection.test.ts src/scripts/topic_clipper.test.ts
```

The regression uses fixed source timings and deterministic model responses. Live
model output still requires editorial listening/viewing review; passing these
tests does not promise that every future semantic decision is correct.
