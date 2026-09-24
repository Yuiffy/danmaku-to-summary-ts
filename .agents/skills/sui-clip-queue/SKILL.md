---
name: sui-clip-queue
description: Manage Sui livestream selection, queued clipping, subtitle correction/burning, AI precision editing and reviewed Bilibili publication. Use for 小岁/老岁 clips, livestream topic search, 精剪/精切 feedback, or improvements to post-stream automatic selection.
---

# 岁己选材切片队列

Use this skill for the whole path from a selected timestamp to a reviewable, upload-ready artifact. Keep selection evidence, media processing, and upload authorization separate: discovering a topic does not authorize uploading it.

## Repository and storage

- Work in `D:\workspace\myrepo\danmaku-to-summary-ts`.
- Keep queue state in the ignored `data/runtime/manual_clip_queue.json`.
- Keep intermediate scripts, screenshots, and temporary media under the source recording's `temp` area or the repository `tmp/`; do not create a `deliverables` folder in the repository.
- Keep final manual clips beside the recording in `manual_requested_clips` unless the user explicitly gives another output directory.
- Read `docs/old-sui-clip-search-playbook.md`, `docs/manual-clip-queue.md`, and `docs/post-stream-residual-audit.md` when the task involves old recordings or automatic selection.
- Recording search roots are split by lifecycle: search the active D-drive root first, then the E-drive archive for older or already-moved recordings. The archive is a source location only; manual clip outputs remain mapped to D for easy cleanup.

## Workflow

### Precision editing and feedback

For 精剪/精切, read [references/precision-editing.md](references/precision-editing.md) for how AI chooses
content, cuts, visual emphasis, placement, audio and final review. The shared automated pipeline uses
these same rules; a one-clip experiment must not become a hardcoded rule for unrelated material.

### Numeric candidate corrections

Own-stream rendered clips, including held/failed clips and rejected candidates,
also reserve numeric IDs. Their single chronological review lists the blocking
issues beside each ID. Read `docs/topic-event-editorial.md#own-stream-review-ids`
for `clips:review`, rendered `subtitles`, and explicit `approve-review` commands.
Registering or refreshing IDs never approves or uploads a clip. `correct` now
routes own-stream clips to a separate versioned rebuild path; it never edits an
already burned video in place or treats a changed SRT as a changed video.

For an own-stream rendered clip, `correct --id ... --from ... --to ...` preserves
the original media/SRT and prepares a revision under the same ID. `cut --ids ...
--review-note ...` renders that revision from the source recording without uploading.
`correct --enqueue` or a later `enqueue` snapshots the revision for the existing
worker to rebuild, audit and upload. Unconfirmed attribution/public copy first
requires `rebuild --id ... --review-note ... --source-kind ...` with reviewed copy.
For rejected overlong own-stream candidates, `rebuild` also accepts a per-clip
`--allow-long --duration-note ...`; optional `--start` and `--end` are absolute
recording seconds and must be chosen before correcting words. Length alone is not
an editorial rejection: retain a coherent longer topic when its setup, development
and ending justify it. Never use a duration note to bypass another rejection.
Published IDs may be revised/rebuilt locally but cannot be enqueued again, even
with `--force`; replacing the existing submission is a separate operation.

For a failed creative precision attempt that retained its ordinary own-stream
video, use `python src/scripts/clip_upload_registry.py precision --id ... --note ...`.
It verifies the source and reviewed baseline, then renders a separate local
revision under `precision_revisions/<ID>/`. Read the returned `RESULT.json` and
QA evidence; a fallback is a failed attempt, not a completed precision clip.
This command does not upload, replace published media, or send notifications.
See `docs/clip-precision-experiment.md` for its contract.
Use `--style compact` when the user wants tight story editing, face/key-object
closeups, denser effects and background music. It keeps approved subtitle words,
maps complete retained cue groups to the shortened timeline, and separately
reviews story continuity, visual focus and actual audio levels. A local retry may
use `--resume-from <revision-directory>` to reuse matching story/moment drafts;
an unchanged timeline and moment list may also reuse the visual draft. Source
and baseline identities are checked again; validation, rendering and final QA rerun.
When gameplay/routes are important, use `--avatar-mode circle` to keep the main
scene visible and enlarge the face in a round inset. Review its three-frame
placement against the character, route, HUD and subtitles. Default
`creative.focusPlacement: source` keeps the enlargement at the original subject
and groups reaction stickers nearby; subtitles move/reflow around it without
shrinking the standard font or changing SRT words. Do not relocate an avatar over
chat merely because a free corner looks convenient. `focusInset` also supports
in-place text/chat or object emphasis, using actual frame dimensions.
For edge avatars, the configured larger face inset may extend beyond the canvas;
keep all source padding outside the visible screen and preserve eyes, mouth and
chin. Do not shrink/reposition a full circle merely to fit its border. During a
full-frame detail zoom, use `faceInset.mode: retain` when the face is cropped out:
sample the original source separately at 1:1 size so the main detail remains dominant.

New compact plans must choose an `editorialProfile` from the content: gameplay,
conversation, story, tutorial, performance or mixed, with matching tone and
density. Preserve tutorial steps and continuous performance; neutral/serious
material must not inherit canned laughter or playful BGM. Do not use a fixed
compression ratio to reject a coherent new plan. Reuse a reviewed legacy comic
profile only for the same bound source and timeline.

The configured `creative.laughAssets` pool rotates distinct approved excerpts,
prioritizing unused material and avoiding adjacent repeats. Check actual source
hash plus excerpt boundaries, not just different asset names. Store the chosen
asset and excerpt in the result and keep source attribution with the catalog.

For an existing numeric candidate ID, use the upload registry directly; do not
create another manual task or run ASR/FFmpeg yourself. Candidate SRTs exist before
the pending stage (older candidates are prepared lazily):

```powershell
python src/scripts/clip_upload_registry.py subtitles --id 123
python src/scripts/clip_upload_registry.py correct --id 123 --from "zzz" --to "睡睡睡" --enqueue --note "用户确认改词并要求投稿"
```

Use the actual ID and exact user-confirmed words. Omit `--enqueue` unless the user
requested upload. `--cue 7` limits a correction to one local subtitle cue; otherwise
all literal matches in that candidate are replaced. The same word in its public
copy is synchronized. A missing match fails without enqueueing. Do not edit the
original recording SRT, approval hashes or queue JSON. The command returns after
queueing; the existing upload worker burns subtitles, makes the cover, audits and
uploads using the same ID. Confirm the worker is online and report queued; do not
wait or poll repeatedly. See `docs/topic-event-editorial.md` for the full recipe.

### Automatic subtitle preparation

New Sui ASR outputs use the room-scoped `asr.subtitleProofreading` stage before
writing SRT. Read `docs/asr-backends.md#自动字幕预校对` for its contract. It applies
curated, context-bound aliases and only uses a unique prior SC with unchanged
anchors for approved SC aliases. Raw ASR, rule IDs and SC provenance remain in
the hash-bound evidence sidecar. Normalization never identifies a speaker or
grants upload approval.

Before asking the user about every unusual word, inspect the clip's
`subtitleProofreading.automaticEdits` and `reviewGroups`. Avoid re-asking an already
confirmed mapping when its local evidence agrees; reopen it when the current
context contradicts the rule. Present repeated ambiguous terms once with all relevant
times, and present a likely foreign-audio span as one grouped issue rather than
inventing separate Chinese questions for each corrupted English word. Include the
matched SC text when available. Keep hesitation/sound effects distinct from words
that change identity, negation, numbers or the main claim.

The generated <=30-second review windows are advisory inputs for a multilingual
audio check, not completed listening or ASR results. This first stage does not
automatically run a second ASR, translate/delete playback, learn global rules from
all correction history, or revisit queued/published clips. Promote new reusable
aliases only with room/context restrictions and negative regression examples;
keep ambiguous short words and one-off full sentences source-bound.

### 1. Find and verify the source

- Use this search order for Sui recordings:
  1. `D:\files\videos\DDTV录播\25788785_岁己SUI` for current recordings and recent dates.
  2. `E:\EFiles\Evideo\DDTV录播-E\25788785_岁己SUI` when the date is old, the D-drive date folder is absent, or the recording has been archived.
  3. Only after both local roots have been checked, consider finding and downloading a Bilibili replay.
- Search the text sidecars in both roots before opening video: `.srt`, `.xml`, `.asr_meta.json`, and related metadata. Prefer a file/date candidate list (`rg -l` or `rg --count-matches`) over dumping every matching line.
- Search local `.srt`, `.xml`, `.asr_meta.json`, and related metadata before opening video. For old Sui topics, search years/months broadly and use ASR variants plus danmaku corrections (for example `CPU`, `12400F`, `3050`, `显卡`, `内存`, `任务管理器`, `拔智齿`).
- Use SRT for the streamer's words and XML for viewer reactions. Do not attribute danmaku text to the streamer.
- Expand a hit into an origin-to-reaction-to-close window. If the old SRT is unreliable, use a deliberately wide rough window and re-ASR only that clip before final boundary adjustment.
- Before manual or automatic selection, read `ownStreamClips.selectionPolicy` and its `roomOverrides[roomId].excludedCategories`. Honor the resolved global and room exclusions for new clips, old-recording clips and residual candidates. Sui's real family/relationship content is excluded; do not repackage it under another title or select it from another streamer's retelling.
- Do not apply blanket content exclusions. Treat films, advertisements, greetings, gifts, songs, and ordinary chat according to whether the requested task gives them independent value; only exclude a category when the task explicitly says so.

### 2. Add a queue task

Use the repository command, supplying source media, SRT, start/end seconds, title, description, and cover text:

```powershell
npm run manual:clips -- add `
  --media "D:\files\videos\DDTV录播\...\录播.flv" `
  --srt "D:\files\videos\DDTV录播\...\录播.srt" `
  --start 1234.5 --end 1356.0 `
  --title "标题" `
  --description "只陈述片中发生的事情" `
  --cover-text "第一行\n第二行"
```

Select the profile explicitly when appropriate:

```powershell
# 普通近期片，默认 profile
npm run manual:clips -- add ... --profile small_sui

# 跨年份旧录播或用户明确说“老岁片”
npm run manual:clips -- add ... --profile old_sui
```

`small_sui` uses the `【小岁】` upload prefix. `old_sui` uses the `老岁片 ` prefix and separate old-clip tags. The profile must not change subtitle size, font, two-stage copy-mode burn, cover source, or timing logic.

### 3. Cut and burn

Run the worker after adding tasks:

```powershell
npm run manual:clips -- list
npm run manual:clips -- worker
```

The worker generates MP4, clipped SRT, burned subtitles, cover, JSON metadata, posting copy, and an isolated REVIEW entry. The standard media settings come from `ownStreamClips` and use the fast two-stage `copy` workflow; do not replace this with slow full re-encoding merely to solve a subtitle offset. Re-ASR is a targeted fallback for bad source subtitles, not the default for every clip.

GPU performance is the default media path for this repository. Read `config/production.json` or `config/default.json` through the project config loader; do not hardcode `libx264` in a new clipping script and do not ask the user to set `DANMAKU_CLIP_CONCURRENCY` or `DANMAKU_CLIP_FFMPEG_THREADS`. The configured path is `h264_nvenc` with `p4`, `subtitleHwaccel: cuda`, and the fast two-stage burn. The automatic resource scheduler samples the foreground process, running processes, NVIDIA telemetry, and host CPU, using the normal idle profile when the machine is free and reducing to `1` worker / `1` FFmpeg thread during game or high-load use. An NVENC/CUDA failure must use the existing `libx264` fallback and still produce burned subtitles when possible.

After a worker finishes, inspect the output JSON fields `resourceMode`, `ffmpegThreads`, `subtitleVideoEncoder`, and `subtitleHwaccel` when performance provenance matters. Performance thresholds are machine-specific and should be remeasured on the target host before changing production defaults; the queue-specific operational summary is in `docs/manual-clip-queue.md`.

### 4. Review and upload authorization

The normal state path is:

`pending_cut` -> `pending_review` -> `upload_queued`

`--auto-upload` changes the post-cut path to `upload_queued`; use it only when the user explicitly says no review is needed. Otherwise inspect the video, subtitle timing, title, description, and cover, then approve:

```powershell
npm run manual:clips -- approve mcq-00001
```

Approval registers the short ID and enqueues it for the existing single-instance Bilibili worker. If the user says a task is already queued and will finish later, stop polling; do not repeatedly inspect upload status.

### 5. Automatic post-stream selection

For the live-end automatic path, inspect `REVIEW.md`. Run the optional `RESIDUAL_REVIEW.md` audit only when the task calls for extra recall. Automatic selection is a recall layer, not upload authorization. Convert accepted candidates into `manual_clip_queue` tasks so both automatic and manually found topics use identical cutting and burning.

Read [references/auto-selection.md](references/auto-selection.md) for the staged selection design, scoring signals, diversity rules, and operational checks.

## Quality gates

- Preserve the complete setup, reaction, and closing sentence; do not start at the punchline.
- Keep source attribution correct: SRT is streamer speech, XML is viewer reaction.
- Verify the actual MP4 duration, subtitle first/last timestamps, and that subtitles are burned into the video.
- Make public descriptions factual and concise; keep internal selection reasons out of the description.
- Use the user's requested naming convention. Do not silently turn an old clip into `【小岁】`, and do not silently upload an unapproved task.
