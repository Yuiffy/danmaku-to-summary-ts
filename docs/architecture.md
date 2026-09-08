# Architecture and language policy

Start here before changing production workflows. This page describes maintained
contracts and operating procedures; task-specific reviews and measured results
belong in ignored local storage under the [file-placement rules](../AGENTS.md).

## Runtime map

```text
Next.js task page -> /api/delayed-tasks (uncached HTTP adapter)
                         |
Mikufans / DDTV events -> WebhookService (one running process, one task owner)
  -> MikufansWebhookHandler / LiveSessionManager
  -> MikufansSummaryQueueWorker
  -> enhanced_auto_summary.js
     -> asr/*.js -> python/*.py (ML/ASR workers)
     -> topic_clipper.js / own_stream_clipper.js
        -> clipping/*_selection.js (decisions)
        -> FFmpeg, subtitle/cover output, review registration
     -> ai_comic_generator.py
        -> comic/storyboard.py / comic/prompts.py
        -> comic/screenshots.py -> local FFmpeg and image sheets
        -> comic/image_inputs.py / image_routes.py -> injected provider adapters
        -> provider calls and image output
  -> generated JSON / Markdown / image sidecars and stdout sentinels
  -> MikufansDelayedReplyCoordinator
  -> DelayedReplyService
     -> DelayedReplyPolicy / ReplyContentReader / DelayedReplyArtifactResolver
     -> LiveContentSummaryComposer / DelayedReplyDiagnostics
     -> SupplementaryReplyWorkflow (comic, separate live summary, summary dynamic)
     -> DelayedReplyScheduler / task store
     -> Bilibili API / WeChat Work notifications
```

PM2 runs `dist/app/main.js`. Compiled service edits take effect only after
deploying the emitted files and restarting/reloading that process. Source-executed
JS/Python edits take effect on the next child invocation, so their CLI and module
exports must remain compatible even while the old service is running.

The Next.js task API forwards to `WEBHOOK_BASE_URL` (default
`http://127.0.0.1:12523`). It must never initialize its own scheduler or modify
production task files. The authoritative endpoints are
`GET /api/delayed-reply/tasks`, `POST /api/delayed-reply`, and
`DELETE /api/delayed-reply/tasks/:taskId`. After deployment, the webhook service
must be updated before using the new task-list/cancellation adapter.

## Ownership

| Area | Owns | Must not own |
| --- | --- | --- |
| `src/app/main.ts` | process/CLI composition | media algorithms, room policy |
| `src/app/api` | web-to-service HTTP adapters | service instances, durable queues |
| `src/core`, `src/utils` | configuration, logging, errors, shared infrastructure | application/service/workflow imports |
| `src/services` | long-running state and external adapters | application/UI imports, one-off batches |
| `services/ai/goodnight` | naming policy, reply prompts and validation | provider HTTP or file persistence |
| `handlers/mikufans` | resource admission, durable summary execution, reply coordination | publishing policy |
| `bilibili/delayed-reply` | task policy, content, artifacts, diagnostics, timers | parent-service imports |
| `src/scripts` | compatible CLIs and existing media orchestration | new long-running services |
| `src/workflows` | strictly typed, compiled stages called by source CLIs | importing source CLIs or services, runtime transpilers |
| `scripts/clipping/*_selection.js` | recall, matching, scoring, boundaries | parent workflows, rendering, uploads |
| `scripts/comic/storyboard.py`, `prompts.py` | script contracts and prompt presentation | provider/config/process IO |
| `scripts/comic/screenshots.py` | local frame acquisition, sheet rendering, shared FFmpeg invocation | provider calls, room configuration |
| `scripts/comic/image_inputs.py`, `image_routes.py` | input ordering/provenance, route attempts/fallback | importing the parent, global configuration or provider clients |
| `src/scripts/python` | ML/ASR model implementations | Node process orchestration |
| `scripts`, `tools` | reusable operator commands and platform setup | application startup side effects |
| `docs`, `plans` | maintained guides, contracts, architecture decisions and roadmaps | task diaries, experiment results, deployment snapshots |
| `local-scripts`, `temp`, `tmp` | task-specific scripts, reports, captures and experiments (ignored) | reusable product behavior |
| `data/runtime`, `logs`, `output`, `build`, `dist` | mutable state or generated artifacts | hand-maintained source |

Dependencies point from entrypoints to services to shared infrastructure. Leaf
components must not import their parent. Existing script paths remain facades;
internal helpers are not exported unless their callers need them.

## Language decision

Keep TypeScript and Python. They serve different runtime/ecosystem needs.

- TypeScript is the default for new Node functionality, HTTP handlers, schedulers,
  queues, shared rules, and long-running services. The control-plane directories
  are TS-only.
- Existing source-executed JS remains supported. Structural extraction of existing
  JS can preserve JS to keep current deployments operational. New logic should be
  TS; migrate a CLI only once its complete compiled release and compatibility
  entrypoint can be tested together. Do not make live JS depend on a dev-only
  transpiler or a partially built `dist`.
- Python remains for ASR, speaker processing, model runtimes, and Python-native
  Bilibili/media tooling. A wholesale rewrite adds risk without reducing the
  number of runtime responsibilities.
- Across processes, use explicit arguments, environment fields, JSON sidecars,
  and documented sentinels. Preserve names, units, required fields, and error
  behavior in contract tests. Incidental log text is not an API.

The service build excludes Next.js routes and TSX. It keeps `allowJs: false`
and `noEmitOnError: true`. The application type check still includes legacy
JS imports during the migration. The unused `tsc-config.json` snapshot and the
obsolete configuration-overwriting migration generator have been removed.

### Compiled workflow releases

`npm run build:workflows` strictly compiles migrated stages to an immutable,
content-addressed directory under `build/workflow-releases`. It writes a candidate
descriptor at `build/workflow-candidate.json` and does not activate that candidate.
Jest and the Node release tests use the candidate; ordinary verification does not
change the active workflow release or production `dist`.

After validation, `npm run workflow:activate` atomically updates
`data/runtime/workflow-release.json`. Source CLIs load all migrated stages from
this one release. `DANMAKU_WORKFLOW_RELEASE` explicitly selects a release directory
for isolated runs. The bridge verifies the manifest and every file digest before
loading modules. It does not import TypeScript or ts-node. Keep prior release
directories for rollback; restore the previous pointer to roll back activation.

Both `node src/scripts/ai_text_generator.js --check-runtime` and
`node src/scripts/enhanced_auto_summary.js --check-runtime` validate/load the
compiled stages without contacting providers, reading production queues, or
starting a scheduler. The larger JS orchestration is still being migrated in
stages; these compatibility entrypoints remain the supported CLI paths.

### Configuration and history

`core/config/config-contract.json` defines the Node/Python contract. The readers
select one main JSON file: explicit `CONFIG_PATH`, then `production.json` when
`NODE_ENV` is `production` or `automation`, then `default.json`. An explicit missing
file is an error. An absent `NODE_ENV` selects development. Production does not
inherit keys removed from its config. This preserves the existing Node behavior
and aligns Python with it. UTF-8 BOMs are accepted; arrays/null replace values and
objects merge when applying secrets. Environment overrides follow secrets.

`ConfigLayers.ts` is used by the service and compiled source-CLI bridge;
`config_contract.py` interprets the same contract for Python. Runtime schemas and
defaults remain in their respective consumers. Cross-language tests compare the
entire merged JSON before those schemas. Relative config paths resolve against the
repository, independent of cwd. `DANMAKU_PROJECT_ROOT` can explicitly select a root.

Both reply stores now resolve `data` from the repository. `ReplyHistoryStore`
imports the historical sibling `../data/reply_history.json`, merges by dynamic ID
(successful records win over failed records), restores dates and preserves the
source file. Backups live in `data/runtime/reply-history-migration`; a digest marker
prevents unchanged records from being reimported after cleanup. Changed legacy
files after a rollback are merged on the next start. Invalid history fails startup
instead of silently creating an empty store.

### PM2 deployment

After `npm run verify:all`, stage service output with
`node node_modules/typescript/bin/tsc -p tsconfig.build.json --outDir dist.next-structure --incremental false`.
Activate the tested workflows with `npm run workflow:activate`, then run
`./tools/deploy-webhook.ps1` from PowerShell. It verifies staged JS/JSON against
`build/service`, checks both CLI releases, refuses processing/imminently due tasks,
snapshots state, preserves future delayed-task identities and deadlines,
restarts only `danmaku-webhook`, migrates history while the old process is stopped,
and verifies health and historical identities. Failure restores the prior `dist`.
This single fork-mode PM2 process has a brief restart window. The script is scoped
to this repository's service on port 12523 and does not deploy other PM2 apps.

## Verification

| Command | Purpose |
| --- | --- |
| `npm run verify:core` | strict application types, service types, architecture, Jest |
| `npm run test:node` | portable Node test-runner cases |
| `npm run test:python` | portable Python suite under `tests` |
| `npm run test:integration` | service-owned HTTP and generated-file/reply workflow |
| `npm run test:compiled` | isolated build plus the same workflow against emitted JS |
| `npm run verify:all` | all portable checks above |
| `npm run test:python:asr` | additional ASR resource/device tests, requires ML dependencies |
| `npm run build:isolated` | candidate service output in `build/service` |

`verify:all` never cleans or emits to production `dist`. There is no implicit
`prebuild` cleanup. `npm run build` still targets `dist` for deployment compatibility;
only use it when updating that runtime is intended. `clean` is explicitly destructive.

Do not indiscriminately execute `src/scripts/test_*`: several historical
diagnostics call paid providers or publish comments. Portable test discovery is
deliberately narrower. Changes to business behavior need focused tests at the
owner; publication changes also need persistence/idempotency workflow coverage.

## Automated constraints

`npm run architecture:check` scans TS, TSX, JS, and Python source/workflow files:

- New production/workflow files have a 1,200 physical-line budget. Existing
  oversized files have per-file frozen budgets in the checker; lower them after
  extraction rather than adding headroom.
- Static TS/JS dependencies are parsed with the TypeScript compiler API. The
  checker rejects dependency cycles and ownership reversals, including web
  adapters importing service instances and decisions importing parent workflows.
- Python files are parsed with Python's AST without importing/executing them.
  Comic contracts/prompts cannot import provider/configuration/process modules.
- TypeScript-only control-plane directories, root-file placement, the service
  build boundary, and absence of implicit prebuild actions are enforced.
- Mikufans recording lifecycle code delegates process/queue work to its worker;
  delayed-reply timers stay in `DelayedReplyScheduler`.

The graph is a static TS/JS graph, not proof about dynamic requires or Python
runtime imports. `--json` produces a machine-readable inventory and violation list.

## Change guide

| Symptom/change | Start here |
| --- | --- |
| recording order, reconnect, segment finalization | `MikufansWebhookHandler`, `LiveSessionManager` |
| durable queue, GPU admission, child-process progress | `MikufansSummaryQueueWorker`, `MikufansAsrResourceController` |
| room names or generated goodnight wording | `GoodnightReplyPolicy` |
| missing output path or delayed registration | `MikufansDelayedReplyCoordinator`, `DelayedReplyArtifactResolver` |
| expiry, duplicate identity, retry classification | `DelayedReplyPolicy` |
| front matter, body cleaning, publishability | `ReplyContentReader` |
| primary publication, task locks, cancellation | `DelayedReplyService` |
| supplementary publications, durable intent and independent retries | `SupplementaryReplyWorkflow` |
| summary/comment length or generation diagnostics | `LiveContentSummaryComposer`, `DelayedReplyDiagnostics` |
| keyword window, candidate recall, subtitle boundaries | `clipping/topic_selection.js`, `clipping/own_selection.js` |
| storyboard JSON or comic prompt presentation | `comic/storyboard.py`, `comic/prompts.py` |
| requested screenshots, source-video resolution, local FFmpeg capture | `comic/screenshots.py` |

Continue decomposing large orchestrators at the ownership boundaries above;
line budgets are maintained in the architecture checker. The history migration
contract is described under Configuration and history. Do not move existing
persistent stores as a cosmetic cleanup; untrack ignored logs without relocating
the paths used by running processes.
