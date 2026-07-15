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
