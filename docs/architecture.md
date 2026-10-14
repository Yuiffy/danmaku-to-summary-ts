# Architecture and language policy

Start here before changing production workflows. This page describes maintained
contracts and operating procedures; task-specific reviews and measured results
belong in ignored local storage under the [file-placement rules](../AGENTS.md).
For setup and focused test commands, use the [development guide](development.md).

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

The upload runner is an exception to per-job child loading: its Python
`clip_upload_registry.py worker --loop` process retains imported quality gates
across jobs. After deploying changes to those Python modules, check that no job
is running and restart `clip-upload-queue-runner` before enqueueing affected
clips. Activating a workflow release or restarting the admin API does not refresh
these imports. A queue receipt confirms admission only; inspect the worker
failure and submission receipt when diagnosing a failed upload.

The batch uploader pins the SDK's official BDA2 line, matching its preupload
availability probe. This avoids the SDK's automatic speed test selecting an
unhealthy alternate CDN. TLS verification stays enabled, and failures still
pass through the existing durable submission-intent reconciliation before retry.

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
| `services/admin`, `tools/admin` | loopback operator API, fixed config files with revisions/backups, registered media streams and serialized existing CLI intents | media algorithms, direct clip/upload queue mutation, an additional delayed-reply scheduler, process deployment |
| `src/core`, `src/utils` | configuration, logging, errors, shared infrastructure | application/service/workflow imports |
| `src/services` | long-running state and external adapters | application/UI imports, one-off batches |
| `services/ai/goodnight` | naming policy, reply prompts and validation | provider HTTP or file persistence |
| `services/live-vote/reminders` | configured-room daily reminders, quiet-window decisions, durable send intent, admin commands and room/WeChat adapters | independent send queue, recorder connections, medication dosage decisions; composition stays in `runVoteBot` and `MultiRoomVoteBot` |
| `services/live-vote/questions` | bounded configured-room evidence; `QuestionScope` explicit-name routing, `QuestionCorpus` sequential cross-room retrieval, `GiftCatalog` read-only curated gifts; question agent and global admission/cancellation | shell/arbitrary filesystem tools, media processing, publication, independent send queues |
| `services/live-vote/questions/SubtitleIndex`, `SubtitleCorpus`, `EmbeddingClient`, `LocalEmbedding` | versioned subtitle shards, bounded semantic recall, fixed embedding adapters; local inference process has fixed executable/script/arguments from trusted config | agent-controlled process execution, chat publication, cross-room retrieval |
| `tools/live-vote/subtitleIndex` | single-writer incremental index maintenance, daily Shanghai schedule and catch-up | vote admission, active workflow activation, public replies |
| `live-vote/question-lab`, `questions/EvidenceQuery`, `tools/live-vote/recordingQuery` | loopback question/evidence UI, read-only CLI retrieval, independent local test admission | Bilibili sending, comment publication, bot authorization changes, index mutation |
| `services/bilibili/question-records` | fixed bot-owned summary-dynamic evidence comments and publication-intent journal | agent tool access, arbitrary targets, existing delayed-task store writes |
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

`services/webhook/FileMerger` owns merged recording XML. Its embedded browser
preview keeps JavaScript in CDATA so the complete output is well-formed XML.
Comment text and user attributes are decoded once on read and escaped once on
write, including when merging a merged file again. Entry parsing tolerates old
malformed preview markup; relative times still use segment durations plus the
existing gap policy, and the remaining `p` fields retain their values.

Clip previews and cutting share `clipping/media_runtime.js` for FFmpeg execution
and packet probing. `clipping/own_review_state.js` persists review artifacts using
an injected Markdown renderer; `own_review_artifacts.js` owns refresh orchestration.
Subtitle rebuilding and approval share `clipping/rendered_revision_evidence.js`
instead of importing each other's entrypoints. Audio configuration policy lives
in `audio_config.js`, and legacy REVIEW parsing lives in `clip_review_parser.py`;
the original entrypoints retain their public exports.
The historical `clipping/media_process.js` and `clipping/rendered_subtitles.js`
paths forward to `media_runtime.js` and `rendered_revision_evidence.js`.
`clip_upload_cli.py` forwards parser construction to the registry's current
factory so both entrypoints expose the same commands and arguments.

Viewing black-transition cuts use `workflows/clipping/watchBlackPolicy.ts` for
normalized movie-region validation, bounded scan windows and joint continuous
part selection. `watchBlackRuntime.ts` owns source-bound scan evidence/cache and
accepts the existing `media_runtime.js` FFmpeg adapter; it does not import source
CLIs, infer upload authority or write queues. The activity CLI's `watch-splits`
command is a local evidence preview. See [stream activity clips](stream-activity-clips.md)
for region review, timing/threshold contracts and optional integration.
Movie transitions only refine the existing editorial part plan. Viewing targets
and maxima are finite positive seconds chosen for the work's review needs;
alignment preserves the planned part count and length pattern, including short
or long parts, and obeys that plan's configured maximum rather than a fixed
twenty-five-minute target or thirty-minute cap.

The Next workspace proxies `/api/admin` to the loopback operator service (15127),
using a server-only token; delayed tasks still forward to their webhook owner.
`core/admin` contains serializable contracts. Reminder operator edits append to
the reminder inbox and are applied/acknowledged by the existing bot tick; the bot
remains the sole reminder state writer and preserves send receipts. Private
workspace evidence queries reuse the question-lab gate and bounded corpus with
no send/publication adapters. See [web-admin.md](web-admin.md) for configuration
revisions, media roots, command authorization and startup/validation contracts.

Viewing public aliases are pure policy in `workflows/clipping/watchPublicNames`;
the presentation facade binds each alias to the evidenced internal identity and
uses it consistently across public copy, Ps and covers. Python upload review
rechecks those bindings and host/column-only tags. Collection title edits use the
full section query when the episode is absent from the four-item season preview.

Optional title alternatives use `core/admin/titles` for shared contracts,
`AdminTitlePolicy` for evidence-bound prompts/validation, and `AdminTitles` for
admin-only drafts and selection history. Generation never changes the current
default. Existing CLI-backed review commands apply explicit selections; durable
job `titleChoice` snapshots measure submitted intent separately from selection
and task outcome. No direct clip metadata/queue writes or automatic default
strategy promotion are allowed. See the title statistics contract in `web-admin.md`.

Cover editing uses `core/admin/cover` for normalized video-relative selections,
`services/admin/AdminCoverPreview` for disposable previews, and the registry's
`cover` command (`scripts/clip_cover_editor.py`) for locked artifact changes.
`cover_selection.py` validates time/crop, extracts and crops the frame before the
existing cover generator adds text. `coverSelection` binds the saved choice to a
part and media identity; ordinary review/copy repair reuses it only on that same
video. Saves invalidate prior approval and never enqueue publication. Preview and
save share the actual renderer, and Web adapters accept registered IDs only.

`audio_archive_pruning.js` owns archive video traversal and protects exact source
recordings named in clip replay receipts; naming predicates are injected by the
compatible `audio_processor.js` facade. `clip_media_retention.py` owns uploaded
clip expiry and durable replay recipes, while `clip_media_restore.py` invokes the
existing media renderers without mutating publication state. The standalone
Windows maintenance task is described in [clip media retention](clip-media-retention.md).

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

When a source-executed CLI adds a `loadWorkflow` entry, register that entry in the
release builder and its isolated test fixture. Validate and activate the complete
release before running the updated CLI in production; an older active manifest
cannot load the newly added entry. Use an explicit release directory for isolated
validation rather than assuming the latest candidate is active.

`buildSubtitleEvidence().sourceSha256` retains its v1 source serialization when
public speaker policy changes. Its historical row label is a digest input only;
cue speakers and public copy still require independently verified identity. A
policy update must not masquerade as a changed recording or invalidate unchanged
source/subtitle revisions.

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
| `npm run verify:quick` | strict application types, service types, lint, architecture |
| `npm run verify:core` | quick checks, candidate workflow build, Jest |
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
| @鹿饼 recording questions, agent tools, query limits | `live-vote/questions`; runtime/send composition stays in `runVoteBot` and `MultiRoomVoteBot` |
| 岁己 daily reminders, quiet windows, reminder commands | `live-vote/reminders`; share the bot send queue and persist intent before sending; contracts in `docs/live-vote.md` |
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
