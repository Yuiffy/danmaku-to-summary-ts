---
name: sui-clip-queue
description: Manage Sui livestream clip selection from local SRT/XML evidence through queued cutting, trusted ASR correction, universal large-subtitle burning, cover generation, review, and optional Bilibili upload registration. Use when the user asks to find a Sui livestream topic, make a normal 小岁 clip, make an old-recording 老岁片, queue a selected time range, burn subtitles, or improve post-stream automatic clip selection.
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

### 1. Find and verify the source

- Use this search order for Sui recordings:
  1. `D:\files\videos\DDTV录播\25788785_岁己SUI` for current recordings and recent dates.
  2. `E:\EFiles\Evideo\DDTV录播-E\25788785_岁己SUI` when the date is old, the D-drive date folder is absent, or the recording has been archived.
  3. Only after both local roots have been checked, consider finding and downloading a Bilibili replay.
- Search the text sidecars in both roots before opening video: `.srt`, `.xml`, `.asr_meta.json`, and related metadata. Prefer a file/date candidate list (`rg -l` or `rg --count-matches`) over dumping every matching line.
- Search local `.srt`, `.xml`, `.asr_meta.json`, and related metadata before opening video. For old Sui topics, search years/months broadly and use ASR variants plus danmaku corrections (for example `CPU`, `12400F`, `3050`, `显卡`, `内存`, `任务管理器`, `拔智齿`).
- Use SRT for the streamer's words and XML for viewer reactions. Do not attribute danmaku text to the streamer.
- Expand a hit into an origin-to-reaction-to-close window. If the old SRT is unreliable, use a deliberately wide rough window and re-ASR only that clip before final boundary adjustment.
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
