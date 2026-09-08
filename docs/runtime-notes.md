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

## Full-Input Reply And Overview

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

`*_REPLY_SUMMARY.json` owns the draft, accepted result, review, source fingerprint,
request IDs, timings and recorded usage. `*_LIVE_CONTENT.json` references shared
usage instead of generating the overview again. Existing replies are not
overwritten; committed results can restore missing derivatives without a new
model call. Concurrent writers are locked. Queued or ambiguous transport outcomes
must be resolved before another request; failed attempts remain in accounting.
Disabling the room flag affects future tasks, not permission to resubmit an
unresolved request.

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
EXE、参数数组和工作目录启动，不自动改录播姬设置。暂停控制和重启限额均持久化。
本守护只处理进程消失，不解决“进程仍在但录制卡住”的情况。

`npm run recorder:test` 运行单元测试；Windows 设置 `RECORDER_WATCHDOG_NATIVE_TEST=1`
可额外验证一个临时测试进程的退出、重启和恢复，测试不会停止真实录播姬。
