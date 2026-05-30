# Runtime Notes

## Webhook Service

- Start/restart with `npm run pm2:restart`
- PM2 process name: `danmaku-webhook`
- Runtime port: `12523`
- Base URL: `http://127.0.0.1:12523`
- Delayed reply endpoint: `POST /api/delayed-reply`

## Delayed Reply Workflow

- Manual delayed reply requests should use ASCII-safe file paths when possible.
- If a request contains non-ASCII paths and the client encodes them badly, the service may read them as `??` and fail file lookup.
- For replays, prefer restarting the PM2 service after correcting `data/delayed_reply_tasks.json`.
