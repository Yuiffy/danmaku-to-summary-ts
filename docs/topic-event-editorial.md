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

注册表状态：`pending_cut`（待定，有粗剪预览和 SRT）→ `queued`（已授权）→ `rendering`
→ `uploading` → `uploaded`。媒体或证据校验失败会保留候选和错误信息，停止投稿；
在 `show` / `queue` 中查看原因，修正后重新入队。已排队或正在烧录的字幕版本不能再修改。

制作阶段按 ID 隔离失败：某条字幕、文案或媒体校验失败，只停止该条；同任务内
其他候选继续制作，已通过的成片继续上传。`queue` 的 `renderFailures` 保留各 ID
的原因，重启或上传限流重试不会重新处理这些失败条目。其他条目结束后，含失败项
的任务仍显示 `failed`，成功条目保持 `uploaded`；修复后仅重新入队失败 ID。

文案数字校验支持同一条片内证据中的中文日期与阿拉伯数字日期等价，例如
“二零二零年十二月”对应“2020年12月”。逐字读出的两位年份加月份（如“二零年
十二月”）以原录播年份为基准，解释为最近一次已到达的对应年份；录播年份缺失
时不补全世纪。月份、日期须成组匹配，不能跨字幕或不同日期拼接，也不能用日期
数字支持金额或次数。该规则用于初次选材和队列制作，不改写字幕或文案，不解除
来源、归属和媒体校验。

## Own-Stream Review IDs

岁己整场自动切片使用一份按起始时间排序的 `REVIEW.md` / 企微总清单。
每条都显示全局候选 ID、时间和状态；已成片、待复核、复核不可用、
制作失败及被规则剔除的候选不会因为状态不同而打乱时间顺序。
剔除项只保存元数据和可定位的字幕，不自动切视频。批次级模型异常附在清单末尾。
企微只保留有助人工判断的复核说明、原文节选和剔除说明，不逐项展开机器校验码；
完整“核对项”仍保存在本地 REVIEW/JSON，不改变复核状态或上传拦截。

文案应保留已经核实的人名：现场嘉宾、被提及者、转述中的执行者和对象一视同仁，
优先使用配置的公开称呼（例如“小栞”），不因为本人未出声就退化成“对方”。
每个字段先交代姓名后可自然使用代词，抽象封面不强塞名字；真正泛指、重名或只有
同音 ASR/弹幕猜测时仍保留未知。复核已经证实角色姓名但文案仍匿名时，走现有的
有限次文案修订或保持待复核，不做脱离证据的全文替换，也不自动改已投稿内容。

ID 是定位依据，不是通过审核或授权投稿。`UPLOAD_MANIFEST.json` 也会包含被保留的
待复核记录；注册时使用 `import-json --include-pending`，对应状态为 `needs_review`。
普通上传读取仍严格校验，仅对 `--only` 选中的条目加载质量门禁；未选中的待复核条目
不会阻塞同批已通过的条目。`--force` 不会解除复核限制。

已存在的录播可不重跑模型、不重剪，只补 ID、更新总清单并按需补发企微：

```powershell
npm run clips:review -- --plan "D:\recordings\own_stream_fun_clips\PLAN.json"
npm run clips:review -- --plan "D:\recordings\own_stream_fun_clips\PLAN.json" --notify
python src/scripts/clip_upload_registry.py show 123
python src/scripts/clip_upload_registry.py subtitles --id 123
```

重复刷新保留原 ID，不把重新排列后的行号当作全局 ID。未变化的通知不会重复发送；
网络调用结果不明确时保留通知回执，禁止直接重发整批。

对**已经生成且烧好字幕**的自有直播片段，人工核对视频与原文后，可明确保存复核：

```powershell
python src/scripts/clip_upload_registry.py approve-review --id 123 --review-note "已核对片中人物、原话及文案" --title "核对后的标题" --description "只描述片中事实" --cover-text "第一行\n第二行" --source-kind live_speech
```

该命令不调用 AI、不重做 ASR，也不投稿；只验证文案出处、生成对应封面并保存绑定
视频、字幕、封面、文案、窗口和原始来源的人工确认。原 AI 复核结果不覆盖。
原文不支持的引号/数字、来源变动、缺失或失败的媒体仍会拦截。
已剔除但未切出的项必须先确认窗口并重新生成；连贯长片可使用下文的逐条时长授权，不能仅凭确认文字直接发布。
这里不修改已烧录的字幕；字幕有误时不能用文案确认替代字幕修正。
确认后再次明确 `enqueue --ids 123` 才是上传授权。编号命令会区分自有直播修订与
未渲染的关键词候选，两种元数据协议仍独立。

### 已成片字幕校对与重压

`correct` 也支持 `own_stream_fun_review` 成片，包括待复核或制作失败项。
它只保存逐条字面修订，不运行 AI/ASR、不覆盖原视频或源录播 SRT：

```powershell
python src/scripts/clip_upload_registry.py subtitles --id 123
python src/scripts/clip_upload_registry.py correct --id 123 --from "原词" --to "核实后的词" --cue 4 --note "已核听第4条"
python src/scripts/clip_upload_registry.py cut --ids 123 --review-note "已核对字幕与文案，重压待查看"
```

新字幕、旧版本及元数据历史保存在成片目录下 `subtitle_revisions/<ID>/`。
重压从源录播按原窗口生成新的 MP4、SRT 和封面，复用标准 NVENC/CUDA 两阶段
copy 模式及 CPU 回退；绝不在已烧字的视频上再叠一次字幕。批准的 SRT 字节直接
送入压制，避免二次改词、重分句或修改时间戳。编号、复核索引和投稿状态文件不变。

若文案或人物归属仍需确认，先准备修订：

```powershell
python src/scripts/clip_upload_registry.py rebuild --id 123 --review-note "已核对原话和归属" --source-kind live_speech --title "核对后的标题" --description "只描述片中事实" --cover-text "第一行\n第二行"
```

`rebuild` 只准备待重压资料，不立即压制或投稿。按需在校对之前同时传入
`--start` / `--end` 调整源录播的绝对秒数；已保存改词后拒绝改窗，以免丢弃修订。
`approve-review` 仍只确认已生成的视频；存在待重压字幕时不能用它批准旧视频。

用户明确要求校对后投稿时，最后一条 `correct` 可附加 `--enqueue`，或单独执行
`enqueue --ids 123`。已有文案/来源复核可继承，未确认的归属须先通过 `rebuild`
明确保存。队列绑定字幕版本、哈希、文案和原始来源，worker 重压并通过媒体审计
后才能投稿。入队命令立即返回；确认 worker 在线即可，不在会话里反复轮询。
字幕修改会使旧视频暂不可上传；改词失败不入队，排队中的版本不可修改，重试复用
已成功生成的版本。已投稿 ID 允许本地校对重压，但禁止 `enqueue`（包括 `--force`）
再次投稿，需走原稿替换流程。

已经成片的关键词切片（`local_review` / `topic_candidate_manual_cut`）也通过同一
`rebuild` / `cut` 入口按原 ID 补齐话题上下文。先核对起因、指代、讨论和收尾，
再以源录播绝对秒数保存完整窗口及对应文案：

```powershell
python src/scripts/clip_upload_registry.py rebuild --id 123 --start 1200 --end 1290 --review-note "已核对完整话题、人物和发布文案" --source-kind live_speech --title "完整主题标题" --description "片内事实概述" --cover-text "主题封面" --xml "D:\录播\原录播.xml"
python src/scripts/clip_upload_registry.py subtitles --id 123
python src/scripts/clip_upload_registry.py cut --ids 123 --review-note "已检查修订字幕，生成完整窗口待查看"
```

`--xml` 仅在旧元数据漏存原弹幕路径时显式补充；保存后绑定文件哈希，不能替换
已有路径或忽略之后的源文件变动。不指定时，旧关键词稿件可继续使用原复核保存
且仍位于新窗口内的弹幕证据。原 `aiReview` / `editorial` 留作历史，新窗口的
文案、字幕与人工复核独立绑定；旧窗口的 ready 状态不会批准新视频。重压保留
原视频、数字 ID、复核索引、已投稿 BV 及状态文件，复用标准 GPU 压制和媒体审计。
已投稿稿件最后须替换原线上稿件，不能通过 `enqueue` 新投一次。

### 连贯长片的逐条授权

自动选材时长上限不是对长内容价值的否定。若一个完整事件或连贯主题确实需要
较长铺垫、讨论和收尾，可以保留完整长度，同时让标题、简介概括全段，而不是仅
描述开头的笑点。若中途已换嘉宾、开始新游戏或进入独立事件，应重新选窗。

对仅因 `duration_out_of_bounds` 被剔除的自有直播候选，可保留原 ID 和原窗口：

```powershell
python src/scripts/clip_upload_registry.py rebuild --id 123 --allow-long --duration-note "同一主题的完整铺垫、讨论和收尾，缩短会丢失必要上下文" --review-note "已检查完整选材范围和发布文案" --source-kind live_speech --title "涵盖全段的标题" --description "全段内容的事实概述" --cover-text "主题封面"
```

这会保存绑定当前起止时间的 `durationApproval`，保留原剔除理由及证据，不提高
全局自动选材上限。`--allow-long` 必须有非空理由；源证据、最小时长、片内引文/
数字、人物归属和媒体校验仍生效。仅改时长授权不能解除重叠等其他剔除原因。
之后照常 `subtitles` / `correct` / `cut`；确有投稿授权时才附加 `--enqueue`。

回归验证：

```powershell
python -m unittest tests.test_own_revision_registry tests.test_topic_candidate_registry tests.test_review_pending_registry
npm test -- --runInBand src/scripts/render_own_revision.test.ts src/scripts/review_rendered_clip.test.ts
```

可选真实媒体测试：设置 `DANMAKU_TEST_REAL_MEDIA=1` 后运行
`tests.test_own_revision_registry.OwnRevisionRegistryTests.test_real_source_render_and_media_audit_without_upload`。
该测试使用隔离注册表和合成源录播，不投稿。`DANMAKU_MEDIA_TEST_OUTPUT` 可指定本地
测试产物目录（在仓库内应使用被忽略的 `temp/`）。

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
`ready` candidates receive burned final media and covers. Every held candidate gets
an editable, clip-relative SRT and an unburned stream-copy review preview before
registration, including already corroborated AI corrections but not rejected guesses.
Failed or `needs_review` candidates retain evidence and reasons, and reserve globally unique numeric IDs in the same
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
upload authorization. Automatic discovery prepares rough previews for held
candidates without burning subtitles, approving content or authorizing upload.

### 待预审粗剪视频

待预审候选自动生成 `*_preview_rNNNN_*.mp4` 和同名 `.srt`，在同一目录打开视频即可
由支持外挂字幕自动加载的播放器载入。`REVIEW.md` 提供可点击链接，并显示候选在
粗剪中的起止秒数。默认保留前 8 秒、后 2 秒上下文；copy 模式可能多保留一个关键帧
间隔。字幕按实际视频包时间戳校准，包含上下文及当前候选已确认的改词。
候选的版本化 SRT 仍以候选起点计时；预览 SRT 以粗剪起点计时，二者不能互换。

旧候选或粗剪失败项可按原编号补生成，支持逗号分隔的多个编号：

```powershell
python src/scripts/clip_upload_registry.py preview --ids 123,124
```

命令不需要预先批准文案或人物归属，不调用 AI/ASR、不烧字、不生成封面、不投稿。
失败按 ID 隔离，保留可重试原因；上传队列正在处理的编号不能同时生成预览。
粗剪保存在独立 `reviewPreview` 元数据中，不填写成片 `output.mediaPath`，不改变
`pendingCut`、字幕确认或上传状态。`show` 也能查看粗剪路径。

重复准备复用现有视频；`correct` 会同步更新同名预览 SRT，保留原候选字幕修订历史。
后续 `cut` 或已授权 worker 校验源文件、视频文件和窗口后，直接使用粗剪完成精确
裁边及标准 GPU 字幕烧录，封面清理不会删除预览。重新选窗或源媒体变化会使旧粗剪
失效，重新生成时保留旧预览。源字幕证据变化仍须重新预审，不能用粗剪绕过证据校验。

`review.qualityRules` enables the source-grounded quality constraints; an extra
independent audit is optional, not required on every single-call preparation.
Quality preparation also returns a `boundaryReview`: setup/closure cue IDs,
reasons for both boundaries, dependencies from delayed answers or pronouns to
their prerequisite cues, and any unresolved cue IDs. The editor must follow the
earlier incident across intervening chat, include all necessary source footage,
or hold the candidate. Local validation holds missing, unseen, out-of-window or
unresolved prerequisites; it does not silently expand a clip or turn outside
evidence into public copy. Linked IDs establish traceability, not semantic proof.
The review is preserved in the plan and per-clip `aiReview`; staged final copy
keeps the locked review. Legacy configurations without quality rules retain the
optional schema. Request version changes invalidate old selection caches without
revisiting already rendered or published candidates. This adds no model round.

Within the existing audience-row budget, target-name messages and messages
closely repeated in nearby speech receive shared priority; remaining slots keep
context coverage. A flood of keyword messages must not erase a delayed question.
This affects evidence recall only, never speech attribution or identity approval.
Candidate 2268 exposed both failures: uniform sampling dropped the introduction
and delayed question, and the selected answer lost its earlier group-chat setup.
Regression coverage lives in `preflight_boundaries.test.ts`; live semantic quality
still requires editorial inspection.

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
