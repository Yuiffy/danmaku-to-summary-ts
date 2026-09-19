# Runtime Notes

本页只记录当前运行事实和常用命令；项目链路见 [README](../README.md)，ASR 细节见 [ASR Backend 配置](asr-backends.md)。

## Webhook Service

- PM2 process: `danmaku-webhook`
- Source entry: `src/app/main.ts`
- PM2/runtime entry: `dist/app/main.js`
- Production config: `config/production.json`
- Production port: `12523` (`webhook.port`)
- Base URL: `http://127.0.0.1:12523`
- Development command: `npm run dev` (`--port 12522 --host 0.0.0.0`)

`src/app/main.ts` currently applies only explicit `--port` / `--host` command-line options. `ecosystem.config.js` still declares `PORT` / `HOST` environment variables, but those variables are not the port authority for this CLI; use `config/production.json`, `WEBHOOK_PORT` / `WEBHOOK_HOST`, or explicit CLI flags.

## Commands

```powershell
npm run build
npm run pm2:start
npm run pm2:restart
npm run pm2:status
npm run pm2:logs
```

`npm run pm2:restart` targets the complete `ecosystem.config.js`, not only one process. Use a process-specific PM2 command when other managed jobs must remain untouched.

## Current endpoints

- Health/status: `GET /health`, `/status`, `/history`, `/processing-files`
- Recorder hooks: `POST /ddtv`, `POST /mikufans`
- Bilibili API: `/api/bilibili/*`
- Manual delayed reply: `POST /api/delayed-reply`

The handler source under `src/services/webhook/handlers/` is authoritative for request shapes.

## 录播日志状态监控

`bilibili.danmuRiskControl` 默认每 30 分钟读取 mikufans 的 JSONL 日志，不再启动
Python 弹幕探针，也不主动调用 B 站 API。`roomIds` 限定弹幕连接告警房间；共享
API 的 `-352` 按接口告警，不会冒充某个房间独有的问题。API 恢复与弹幕认证恢复
分别通知：获取令牌不等于弹幕已连上，既有连接仍能收消息也不证明接口风控解除。
连接异常持续至少一分钟才通知，读取周期决定通知延迟；短暂掉线后立即恢复不告警。

`recorderStatePath` 默认 `data/runtime/recorder_watchdog.state.json`。每次读取核对
守护心跳、当前 PID、启动时间及进程是否存在；不根据日志中的最大 PID 猜测当前进程。
`logDirectory` 留空时使用该进程 EXE 旁的 logs；支持日志追加、未写完的行和轮转。
当前构建须保留结构化日志中的 `ProcessId`、`@t`、`@mt` 和相关事件字段。

`monitorStatePath` 默认 `data/runtime/recorder_log_monitor.json`，持久化读取位置、
事件和待发通知。首次启用从当前时间开始，不重放历史告警；服务重启后续读。
开始与恢复通知按发生顺序补发，恢复时间使用日志事件时间，不宣称补发时仍为当前状态。
通知成功后移出队列。文件丢失、身份过期或没有明确恢复记录时，状态为未知，绝不报恢复。
极端情况下通知已送达但落盘前进程崩溃，仍可能补发一次。

下播兜底 `MikufansOfflineFallbackMonitor` 也复用这个日志读取器的房间状态，不再
每分钟逐房间请求 getInfoByRoom。同一条日志不会算作多次下播确认；确认速度由录播姬
自身的查询频率决定（其他房间每六分钟一条新状态时，三次确认会相应延后）。超过十分钟
的房间状态不再用于判断。无法读取日志时不降级成网络请求；录播姬本身停止更新状态的
情况交由进程守护、文件和停录诊断处理。业务所需的动态查询、评论和上传不受此项影响。

## Delayed Reply Workflow

- Before AI reply generation, the existing one-shot dynamics lookup also captures
  the latest post in the live-end window (30 minutes before the end through lookup
  time, never before recording start). Recording end uses ASR media duration, with
  the last subtitle end as a fallback; missing/invalid timing does not select a
  post. The selected text and ID are stored as `replyDynamic` in
  `*_LIVE_CONTEXT.json`, separately from pre-stream `recentDynamics`.
- The reply may briefly respond to that post, but its text is not live evidence
  for the overview or comic and does not change the shared prompt-cache prefix.
  Combined reply/overview generation and review use `P1` for post-only reply
  evidence, alongside the original T/D live evidence.
- This adds no polling, wait-for-post step, or AI rewrite. No eligible text post,
  missing UID, disabled dynamics context, or a failed/timed-out lookup leaves the
  original reply flow intact. The optional lookup has a total timeout (default
  5 seconds). Posts appearing after the snapshot do not trigger regeneration;
  the existing delayed-reply target selection and publication timing are unchanged.
- Manual delayed reply requests should use ASCII-safe file paths when possible.
- If a request contains non-ASCII paths and the client encodes them badly, the service may read them as `??` and fail file lookup.
- For replays, prefer restarting the PM2 service after correcting `data/delayed_reply_tasks.json`.
- A live-content summary that needs a separate send is posted under the original
  goodnight comment, not as another top-level comment on the dynamic. Its parent
  reply ID is persisted before sending. Missing parents never fall back to a
  top-level post. `attach_if_ready` still combines a ready summary with the main
  or supplemental reply when it fits, and already-published historical summaries
  are not reposted or moved.

## Goodnight Image Model Policy

New image requests outside Sui's room draw one equally weighted variant through
daiYu: `gpt-image-2/high`, or `gpt-image-2.5-sunburst` / `gpt-image-2.5-flare` at
`low`, `medium`, `high`, `xhigh`, or `max`. If that attempt fails, the next route
tries `gpt-image-2/high` once, including when the initial draw was image-2/high.
A successful first attempt skips the fallback; the fallback does not draw again.
Both default and production configs enable `ai.comic.imageGeneration.rollout`.
Rooms inherit the full global route list unless they define their own. Room
`25034104` inserts the same image-2/high retry before its existing fallback chain.
Room `25788785` continues to prioritize `gpt-image-2.5-sunburst/max` with rollout
disabled. Its bounded fallback chain
continues through tuZi's synchronous `gpt-image-2` strategies, daiYu `gpt-image-2/high`,
then tuZi's asynchronous Gemini route. Keep this chain in the shared `sui` preset
and the default room override: route arrays replace inherited arrays, so pinning
the primary model must include the fallback entries. The asynchronous route runs
only at the end and retains recovery state for resuming an existing remote task.
The image worker reads the current config for each new generation, so these
config-only policy changes do not require a service restart. Requests that already
selected their routes retain that selection.

The rollout mechanism selects the primary `model` / `quality` variant once per
image and leaves fallback routes fixed. Room rollout settings override the global
policy. Distinguish the drawn
`rolloutVariant` from the final model when reviewing a fallback result.

`[IMAGE_EXPERIMENT]` logs and `*_COMIC_FACTORY_META.json` retain model, quality,
provider, request IDs, raw usage and timing, including failed route attempts.
`elapsedMs` at the top level measures the whole image stage including retries;
each route attempt also has its own duration. Missing usage is unknown, never zero.
WeCom goodnight/supplemental-image notifications display the final model, quality,
usage and duration. `poststream:usage` exports the variant and quality for comparison.
To end the experiment, disable `rollout.enabled` and set the primary route's model
and quality; room overrides must be updated separately.

Model names and quality settings: [OpenAI image generation guide](https://developers.openai.com/api/docs/guides/image-generation).

## Full-Input Reply And Overview

`fullLiveContextExperiment.sharedOutputCache` is enabled by the `paired` preset
for paired replies and full-source comics. Both tasks use one strict JSON envelope;
the client checks the task discriminator and unwraps the result before existing
reply/source validation or comic parsing. Material-pool comics are excluded because
they read a different prefix. Refusal, malformed output and usage accounting keep
their normal failure behavior; the experiment does not add retries or warm-up calls.

Matching schema is necessary when sharing a rendered prefix, but is not sufficient
to guarantee an upstream cache hit.

`ai.text.sharedPromptCache.continuationEnabled` enables accepted Responses history
reuse (production on, default configuration off). The first normal business request
is captured in memory. Only after its existing output checks succeed is its exact
request and actual assistant message saved under `data/runtime/live-text-cache/`.
Paired generation waits for semantic review; rejected drafts are never promoted.
The next request retains that prefix and appends its current task as user content.
Earlier generated text is explicitly not source evidence; the original full source
and current reviewed activity constraints remain authoritative. No transcript,
dynamic post or generated summary is promoted to developer instructions.

Reuse requires identical source, endpoint, model, instructions, output schema,
reasoning and cache settings. Cache files have integrity checks, an 8 MiB bound and
a 25-minute lifetime measured from the original response; successful writes clean
expired files. Continued responses do not grow another stored history chain.
Missing, expired, incompatible or unreadable state uses the original full request;
cache writes cannot trigger a new generation or invalidate an accepted output.
No prewarming calls or extra model retries are added. `LIVE_TEXT_CACHE_REUSE` logs
the model and source hash; per-attempt metadata records `liveCacheContinuation`.
Actual `cachedTokens` remains the evidence of a hit, not the reuse log alone.

Shiori's standalone outputs can reuse matching plain-text history. Mizuki's paired
outputs share the strict envelope. Miting retains the existing original-excerpt
pool and its full-source fallback; incompatible pool/full-source schemas do not
reuse history. Sui's filtered and complete sources remain separate.
Disable `continuationEnabled` to restore original requests without deleting accepted
artifacts; `sharedOutputCache` can independently be disabled per paired room.
Task-specific cache experiments and token comparisons belong under ignored `temp/`.

Generation presets live in `config/generation-modes.json`. Select a room's preset
with `ai.roomSettings.<room>.generationMode`; `ai.defaultGenerationMode` supplies
the default for other configured rooms. Node services, Node scripts and Python
scripts resolve the same catalog before schema defaults. Preset inheritance is
expanded first, then explicit room settings override it recursively; arrays replace
instead of appending. Unknown names and inheritance cycles fail configuration loading.
Names, identities, reference art, speaker policies and delivery enablement remain
room settings. Presets cannot overwrite these identities or credentials.

| Preset | Label | Behavior |
| --- | --- | --- |
| `standard` | 标准模式 | Filtered source, 100-character reply and normal comic |
| `sui` | 岁模式 | 800-character reply, max-quality image first with fallback routes, existing filtered reply/comic and full overview/clip source |
| `shiori` | 栞模式 | Complete compact source, 250-character reply, separate overview and complete-source comic |
| `paired` | 全文合并模式 | Complete source produces reply/overview together; evidence review and full-source comic |
| `shared-material` | 共享素材模式 | Combined generation also selects original excerpts for comic reuse; full-source fallback |

The labels describe quality/budget preferences, not measured model rankings.
Inspect effective modes with `npm run generation:modes` or
`npm run generation:modes -- <roomId>`. This read-only command defaults to production
unless `NODE_ENV` is set explicitly, and prints generation settings only.
Per-environment overrides may be placed in `ai.generationModes`; source-level mode
defaults remain in the shared catalog.

The opt-in combined workflow is controlled by
`ai.roomSettings.<room>.fullLiveContextExperiment.replySummary.enabled` within
an enabled full-context experiment. Inspect the current room configuration for
rollout membership, model settings and reply length; a historical experiment
report is not the configuration authority.

`src/scripts/full_reply_workflow.js` coordinates a combined reply/overview and
a short source-evidence review. Compact input preserves parsed speech and audience
content after the existing identical-message merge, reducing repeated metadata
formatting rather than filtering by popularity. Stable T/D IDs retain source
locations; provenance linkage does not prove identity or semantic truth.
The comic workflow still reads the complete source and accepted overview through
the existing storyboard, screenshot and image pipeline.

Combined generation requests strict JSON Schema output: `content` must be an
object containing `overview`, `activityTypes`, `songs`, `games` and `topics`;
material mode additionally requires top-level `moments`. The schema does not
replace source-ID, attribution, activity-name or semantic checks. Incompatible
gateways and nonconforming output still take the existing recorded fallback.
Missing fields are never filled with empty arrays just to pass validation; type,
missing-overview and length errors have distinct messages.

`fullLiveContextExperiment.compactEvidence` enables the same complete-source
format without enabling combined generation. It groups adjacent speech from the
same speaker and shortens timestamps while retaining every parsed speech segment
and merged audience message. Invalid speech timing falls back to the original
full format. The overview still precedes the comic so confirmed activities can
constrain its script; delaying it until after drawing would remove that check.

`summaryDeliveryMode: "separate"` publishes the overview under the saved goodnight
reply ID. Delivery does not require another generation call: combined generation
continues to reuse its accepted overview. Cache propagation waits apply to shared
full-source requests independently of comment delivery mode.

Prompt-cache keys and sequential requests cannot guarantee cache hits. Sui's
filtered reply/comic source differs from its complete overview source. Reuse
requires the same rendered prefix, model, settings, cache backend and a live cache
entry. The current gateway rejects explicit cache breakpoints; do not enable
explicit-only mode without a supported breakpoint. Actual request fingerprints,
source-boundary layout, reasoning effort and returned model are recorded in
`AI_USAGE` and `COMIC_SCRIPT_USAGE`, without logging source text. Compare these
with `cachedTokens` before attributing a miss to scheduling. The fingerprint only
covers application-visible fields, not hidden upstream instructions. See the
[OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).

`*_REPLY_SUMMARY.json` owns the draft, accepted result, review, source fingerprint,
request IDs, timings and recorded usage. `*_LIVE_CONTENT.json` references shared
usage instead of generating the overview again. Existing replies are not
overwritten; committed results can restore missing derivatives without a new
model call. Concurrent writers are locked. Queued or ambiguous transport outcomes
must be resolved before another request; failed attempts remain in accounting.
Disabling the room flag affects future tasks, not permission to resubmit an
unresolved request.

The optional `replySummary.sharedMaterial` recipe asks the full-source generation
for cross-stream T/D citations in addition to the reply and overview. After the
existing semantic review accepts the reply, original context around these citations
and all repaired reply/activity citations is collected into `sharedMaterial` inside
`*_REPLY_SUMMARY.json`. AI-written interest labels never become source facts.
Different time ranges retain timestamps, and submitted stories must stay distinct.
Long streams require three time quarters including the last quarter; source budget
overflow falls back to full input without truncation. The comic loader validates
room, parent source hashes, review status, exact original text and budget again.
`sourceCoverage` records whether the comic used full input or selected original
excerpts. Terminal combined failure retains the existing fallback; unresolved
requests still block new requests. Changing comment placement does not regenerate
accepted material.

Read-only usage inspection:

```powershell
npm run poststream:usage -- --output data/runtime/post-stream-usage-latest.json
```

`--root` selects another recording tree; `--since` and `--until` restrict recording
directory dates. Shared calls are deduplicated and missing usage remains unknown,
not zero cost. The output is a token/price-equivalent report, not invoice
reconciliation. Task-specific comparisons and rollout observations stay under
ignored `temp/<date>-<task>/`; runtime reporting stays under `data/runtime/`.

## Recorder Process Watchdog

`recorder-watchdog` 是独立的 PM2 进程，不依赖录播姬 Webhook 或总结服务存活。
Windows 上需要 PowerShell 7；进程观察器只启动一次并持续输出 JSON，不会每轮开新 PowerShell。
企微沿用配置加载器中的 `wechatWork.webhookUrl`，不把机器人地址复制到守护配置或日志。

先用实际录播姬 EXE 配置本机路径，再单独启动守护，不要重启整份 ecosystem：

```powershell
npm run recorder:watchdog -- configure --exe "C:\Tools\BililiveRecorder\BililiveRecorder.WPF.exe"
npm run recorder:watchdog -- check
npm run pm2:recorder:start
npm run recorder:status
npm run recorder:watchdog -- test-notification
```

配置存在忽略的 `data/runtime/recorder_watchdog.settings.json`，可参考
`config/recorder-watchdog.example.json`。`configure --notify-only` 可改为只通知；
改设置后单独运行 `pm2 restart recorder-watchdog`。确认配置正常后运行 `pm2 save`，
让已有 PM2 登录自启恢复它；没有 PM2 登录自启的机器仍需单独配置。

默认每 5 秒检查一次，连续缺失至少 15 秒且至少两次采样确认后告警并尝试启动。
守护刚启动时给 60 秒宽限；每次启动后等 60 秒，15 分钟内最多尝试 3 次。
达到上限会停止自动重试并通知，直到进程稳定恢复或手动 `resume`。
恢复通知要求同一 PID 稳定存在 15 秒，仅确认进程存在，不代表录播已产生文件。
通知失败独立重试，不阻塞重启；正常运行不重复通知。
看见同名但不同/不可读路径或多个实例时不会再启动一份，也不会强杀尚存的进程。

普通关闭和崩溃都表现为进程消失。手动退出或升级前先暂停：

```powershell
npm run recorder:pause -- --minutes 30
npm run recorder:pause -- --indefinite
npm run recorder:resume
```

升级 EXE 路径后需重新 `configure`，并确认该目录的 `path.json` 指向正确录播目录且
`SkipAsking` 为 true，录播目录配置里的目标房间开启 `AutoRecord`。守护使用配置的
EXE、参数数组和工作目录启动；默认不改录播姬设置。暂停控制和重启限额均持久化。
进程守护不解决“进程仍在但录制卡住”的情况。

同一账号的 Cookie 被多个程序使用时，应只由一个程序负责刷新会话。summary-ts 的
自动刷新会写回 `config/secret.json`，旧会话可能被撤销；录播姬保存的静态 Cookie
不会自行跟随更新。可在守护配置中启用 `cookieSync`，设置 `sourcePath` 为该
secret.json 的绝对路径，`recorderConfigPath` 为录播目录内 config.json 的绝对路径。
源文件使用 `bilibili.cookie`，目标使用 `global.Cookie.Value`；两边账号必须一致。

启用后，守护按 `cookieSync.intervalMs` 比较本地会话与设备凭据，默认每分钟一次，
独立于每 5 秒的进程检查。发生变化时先核对文件摘要、
EXE 路径、PID 和启动时间，只替换 Cookie，并重启该录播进程一次；会短暂中断录制。
目标文件旁保存上一份配置 `config.json.before-cookie-sync`，不把 Cookie 写进守护状态、
命令行或通知。暂停、只通知模式、重启冷却和次数上限均有效；正常一致时不重启。
该检查只读取本地文件，不增加 B 站请求。修改守护配置后单独重启 `recorder-watchdog`。

`npm run recorder:test` 运行单元测试；Windows 设置 `RECORDER_WATCHDOG_NATIVE_TEST=1`
可额外验证一个临时测试进程的退出、重启和恢复，测试不会停止真实录播姬。
