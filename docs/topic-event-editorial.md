# Topic Clip Event Editing

The keyword workflow also supports a pre-render review path controlled by
`clipTopics.review.mode: "preflight"`. Its maintained contract is described under
[Preflight Review](#preflight-review); per-run comparisons belong in ignored task storage.
When that path is enabled it replaces the event/copy calls below, rather than
adding two shadow review calls after them. The legacy path remains available.

The keyword topic workflow now treats a publishable event, not a keyword hit or
an arbitrary duration, as the unit of selection. This applies to `clipTopics`;
own-stream and manual-queue selection keep their existing policies.

## 按编号改词并投稿

用户说“把 123 号待定的不确定词 zzz 改为睡睡睡，然后烧录并投稿”时，执行：

```powershell
python src/scripts/clip_upload_registry.py correct --id 123 --from "zzz" --to "睡睡睡" --enqueue --note "用户确认 zzz 应为睡睡睡，并要求烧录投稿"
```

这里的 `123` 是全局数字 ID，不能使用每场重复的 `E1-1` 或 REVIEW 行号。
这条命令只改该候选的字幕、保存用户确认并入队，立即返回；后台
`clip-upload-queue-runner` 自动烧录、制作封面、审计、投稿并回写同一个 ID。
不需要代理生成脚本、手改 JSON 状态、重新 ASR、执行 FFmpeg 或直接调用上传器。

- 想先看待定字幕：`python src/scripts/clip_upload_registry.py subtitles --id 123`。
  老候选没有 SRT 时会补生成，不会烧录或投稿。
- 只改字幕不投稿：上面的 `correct` 命令去掉 `--enqueue`。
- 用户明确只改第 7 条字幕时加 `--cue 7`。否则替换当前候选内所有字面匹配，
  不把 `--from` 当正则表达式；原词找不到则失败，不会偷偷入队。
- 同一文字若出现在该候选的标题、简介或封面文案中，也做同样的字面替换，
  避免字幕与投稿文案不一致，不会重写其他文案。
- 字幕已确认、只需投稿：`python src/scripts/clip_upload_registry.py enqueue --ids 123`。
  普通成片直接排队上传；待定候选由 worker 先烧录，再上传。
- 收到入队成功后，确认 `npm run pm2:status:clip-upload` 在线即可报告“已入队”。
  不要在当前会话等待烧录或不断轮询；未在线时运行 `npm run pm2:clip-upload:start`。
- 字幕修正本身不等于投稿授权。只有用户明确说投稿，才添加 `--enqueue`。
  用户没有确认的其他不确定词不得猜改，也不要把例子里的编号和词用于真实稿件。

候选在进入待定区之前就有独立的 `*_candidate.srt`。每次修正写入新的
`*_candidate_r0001.srt` 等版本，保留旧版本和逐条修改记录；源录播 SRT 不动。
`subtitles` 与 `show` 始终给出当前字幕版本，不必手动寻找长路径。
确认记录绑定源证据、时间范围、字幕哈希、版本号和文案哈希；worker 不会重新生成
未经确认的字幕覆盖改词。上传重试复用已完成成片，重复入队不会新增同一 ID 的活动任务。

注册表状态：`pending_cut`（待定，有 SRT）→ `queued`（已授权）→ `rendering`
→ `uploading` → `uploaded`。媒体或证据校验失败会保留候选和错误信息，停止投稿；
在 `show` / `queue` 中查看原因，修正后重新入队。已排队或正在烧录的字幕版本不能再修改。

## Preflight Review

Enable `clipTopics.review.enabled` with `mode: "preflight"` to prepare all
candidate groups before rendering. `strategy: "single"` produces event boundaries,
keyword decisions, local subtitle corrections and final public copy in one call
per group. `strategy: "staged"` is an explicit alternative, not an automatic retry.
`review.enabled: false` returns to event editing; `mode: "shadow"` is advisory.
Read model, reasoning effort, evidence limits and timeouts from the current
configuration instead of copying the settings of an old experiment.

The request includes complete source subtitles with IDs, ASR/correction provenance
when available, nearby audience evidence and source-host metadata. A keyword hit
does not itself establish identity. Exact model/protocol routing is validated;
failures must not silently switch providers, protocols or reasoning effort.

Persist and validate the complete `_TOPIC_PLAN.json` before media work. Only
`ready` candidates receive rendered media and covers. Every held candidate gets
an editable, clip-relative SRT before registration, including already corroborated
AI corrections but not rejected guesses. Failed or `needs_review` candidates retain
evidence and reasons without rendering, and reserve globally unique numeric IDs in the same
upload registry (`pending_cut`). REVIEW and WeChat show those IDs beside the
per-stream labels such as `E1-1`; a candidate keeps its numeric ID after rendering.
Source changes, unsaved plans and exceeded evidence budgets hold the
affected candidates rather than truncating their subtitles. Never overwrite the
recording's original SRT. Upload approval remains a separate human decision.

Normal clips and candidates share one numeric ID space. An explicit upload request,
`npm run upload:clips -- enqueue --ids 123`, snapshots the approved candidate SRT
and creates a background job. The command never waits for rendering. The existing
single-instance worker renders candidates before grouping and validating uploads;
ordinary clips skip rendering. `--dry-run` only reports the intended action and
never prepares, approves, renders or enqueues. `--force` does not bypass evidence checks.

For a render-only review or a public-copy repair, inspect the candidate with
`npm run upload:clips -- show 123`, then run
`npm run upload:clips -- cut --ids 123 --review-note "Source checked"`.
Use `--title`, `--description`, or `--cover-text` for evidence-backed public-copy
corrections (one candidate per command when overriding copy). The command checks
the source fingerprint, keyword identity, accepted subtitle corrections and final
copy before using the shared GPU manual-cut path. Explicit user approval can
resolve model uncertainty without another model/ASR call. Original-source drift,
modified unapproved SRT bytes, out-of-window evidence and unsupported public copy
still block upload. Approval does not invent missing plans or public copy after
an AI service failure. The original AI review remains alongside the user correction
history and approval snapshot.
After checking the video and cover, run `npm run upload:clips -- enqueue --ids 123`
to publish. The standalone `cut` command never enqueues; only `enqueue` carries
upload authorization. Automatic discovery and ID reservation never render held
candidates or authorize upload.

`review.qualityRules` enables the source-grounded quality constraints; an extra
independent audit is optional, not required on every single-call preparation.
`preflight_facts.js` reads user-confirmed facts from
`data/runtime/topic_verified_facts.json`. Each correction is bound to the exact
source path, SHA-256, time range and user authorization; stale or mismatched entries
do not apply and must not become global ASR replacements. In ordinary host speech,
use the source host by default; distinguish guests, quotations, audience messages
and playback when the source contains evidence for those exceptions.

Acceptance checks cover complete setup and ending, attribution, conditional and
negative wording, subtitle corrections, final copy and the rendered media. Tokens,
elapsed time, model self-approval and unit-test results are not substitutes for
editorial quality review. Keep recordings, prompts, cost ledgers, failed attempts
and visual checks for each comparison under `temp/<date>-<task>/`.

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

WeChat notifications also list every pending preflight candidate with its time
range, title, blocking evidence checks, and relevant source excerpts. Pending
candidates are counted separately from generated media. Overlap suppression
records identify the omitted candidate and retained replacements, and subtract
retained time intervals to report any uncovered ranges directly in the message.
Full coverage means no unique footage was omitted; partial coverage remains a
potential missed-clip issue, not an automatic editorial approval.

Preflight plans preserve both selected and suppressed candidates with an explicit
`selected` flag. `clipTopics.review.transientMaxAttempts` defaults to 2 for daiYu:
explicit transient HTTP errors are retried once on the same model before holding
the group. Local aborts are not retried while the upstream outcome may be unknown.
This does not change the configured model, reasoning effort, evidence validation,
or approval gate, and retry-only changes do not invalidate successful model caches.

Recovery callers can pass `planningGroupIds: ['E9']` to `generateTopicClips` to
retry only a failed group using the same complete source evidence. Unknown or
empty selectors fail before AI requests. Use a separate `clipTopics.outputDirName`
such as `topic_clips/retry_E9` so the partial retry cannot replace the original
whole-stream plan, review, or successful media.

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
