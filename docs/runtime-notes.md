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
