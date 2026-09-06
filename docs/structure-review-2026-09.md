# Repository structure review (2026-09-06)

## Scope and baseline

Review covers tracked application, workflow, operational, and test code. Generated
recordings, caches, runtime queues, and local experiments are not application code.
At baseline there are 117 TS, 3 TSX, 66 JS, 2 MJS, and 115 Python files.
Physical line counts (including blank lines) are used for architecture budgets.

The existing production process is PID 24112, listening on port 12523, started
2026-09-04 23:15:44 Asia/Shanghai. Its health endpoint returned `healthy` before
edits. PM2 uses `dist`; several child workflows execute `src/scripts` directly.
Do not infer the live port from the default PM2 environment (15123).

## Findings and decisions

1. Large workflow files mix pure decisions, parsing, IO, and scheduling. Extract
   cohesive decisions/parsers behind the existing public entrypoints. Keep queue
   state and publication ordering in their current owners during this migration.
2. Architecture checks currently omit the largest JS/Python files. Extend the
   inventory, freeze existing oversized modules with explicit budgets, check
   dependency direction, and reject new oversized files.
3. `prebuild` deletes the live `dist` directory before compilation. Remove that
   implicit cleanup and provide an isolated build command for routine verification.
   A failed compilation or a review must not remove production runtime files.
4. Test commands reference nonexistent directories, omit Node's test runner, and
   mix portable tests with hardware/real-API experiments. Make the portable gate
   explicit; retain separate opt-in ASR hardware and external diagnostic commands.
5. A test embeds a mutable production room allowlist. Replace that dependency with
   a fixture and test configuration merging. Baseline: 41/42 Jest suites passed,
   459/460 tests passed; the existing room-list assertion was the only failure.
6. Python owns ML/ASR and Python-native media/provider tools. TypeScript owns the
   service/control layer. Keep both. Existing source-executed JS is a compatibility
   surface: extract existing logic without adding a new runtime/transpiler dependency.
   New Node functionality should use TS; later CLI migrations need a tested packaging
   boundary before source JS can import compiled TS safely.
7. Historical `test_*.py` / `test_*.js` scripts under `src/scripts` include real
   publishing and paid API calls. They are operator diagnostics, not an automatic
   test suite. Never discover and execute that entire directory as tests.
8. Next.js task routes instantiate an uninitialized second `ServiceManager` and
   duplicate lookup/configuration logic. Replace them with an uncached HTTP
   adapter; list/create/cancel operations all reach the webhook-owned queue.
9. The old migration generator overwrites current configuration/startup scripts;
   its work is already complete. Remove it and the unreferenced `tsc-config.json`
   snapshot, and replace its obsolete guide with maintained documentation links.
10. Whole-tree Python AST inspection exposed an existing syntax error in the
    optional cover-update call in `reclip_and_replace.py`. Repair the call and
    resolve its secret-file path relative to the repository, without executing it.

## Implementation checklist

- [x] Inventory code, read existing architecture, identify active runtime.
- [x] Run baseline TypeScript, architecture, Jest, and portable Python checks.
- [x] Remove implicit destructive build cleanup and repair verification commands.
- [x] Extract delayed-reply content and task policy responsibilities.
- [x] Extract clip selection and comic parsing/identity responsibilities.
- [x] Extend architecture checks across languages and dependency boundaries.
- [x] Run regression tests and isolated compiled workflow smoke tests.
- [x] Recheck production PID/start time, health, runtime/config integrity.

## Operational boundary

Verification uses synthetic media, temporary files, in-memory stores, and mocked
outbound publishing/provider calls. It must not post comments, upload videos,
consume real queues, run a second production scheduler, reload PM2, or overwrite
`dist`. Source-script extractions preserve exported names and CLI paths.

Deployment of compiled changes is separate from source implementation and testing.
The running process continued serving the original runtime during the initial
review. The subsequent deployment request explicitly authorizes replacing that
PM2 runtime; verification remains isolated from production state.

## Measured changes

| Entry point | Before | After | Extracted owner |
| --- | ---: | ---: | --- |
| `DelayedReplyService.ts` | 2826 | 2413 | policy, content reader, artifact resolver |
| `topic_clipper.js` | 3149 | 2378 | topic selection and config |
| `own_stream_clipper.js` | 2982 | 2265 | candidate selection and alignment |
| `ai_comic_generator.py` | 4971 | 4598 | storyboard parser and prompt presentation |
| Next.js delayed-task route | 199 | 53 | HTTP adapter to the existing service |

Extracted algorithm bodies and prompt text retain their original behavior. These
are physical line counts, not claims that moved code was deleted. The actual
deletions are obsolete migration code/configuration, duplicate web orchestration,
redundant delegation methods, and duplicate comic-metadata lookup.

Cancellation is now checked by the service's execution lock, including the
live-status check before the visible `processing` state. A cancelled pending task
is also made terminal in memory so an already queued immediate callback cannot
publish it. Integration tests cover both races.

## Validation results

`npm run verify:all` completed successfully on 2026-09-06. Full output is in
`tmp/structure-verify.log` (local verification artifact, not tracked source).

| Check | Result |
| --- | --- |
| Application type check, service build check, architecture constraints | Passed |
| Jest | 45 suites, 478 tests passed |
| Node test runner | 4 tests passed |
| Portable Python | 224 tests passed |
| Isolated service compilation | Passed; emitted only to `build/service` |
| Compiled goodnight integration | 6 tests passed; repeats the source workflow against emitted JS |
| Additional ASR device/resource tests | 14 tests passed |
| Real FFmpeg media smoke | Passed; 5-second NVENC/CUDA subtitle output, two-stage copy, no fallback |
| Diff whitespace/error check | Passed |

The goodnight workflow verifies generated-file sentinel registration, duplicate
suppression, real Markdown reading, one publication through a mocked Bilibili
adapter, persistence updates, and HTTP creation/listing/cancellation. It also
covers cancellation during the live-status check and before a queued immediate
callback. Stores are isolated in memory; provider and publication calls are
mocked. This is not a live external-provider or real-comment publication test.

The media smoke used synthetic video and actual FFmpeg. The output frame was
visually inspected and contained 1,161 bright subtitle pixels. Local artifacts
are under `tmp/structure-media-N4Lq2B/`; the smoke command is
`node tmp/structure-media-smoke.cjs`. Extraction checks also confirmed 53 moved
JS function bodies were unchanged and 12 moved Python definitions had identical
ASTs.

Final read-only production checks at 2026-09-06 14:49-14:52 Asia/Shanghai found:

- PID 24112 still owns listening port 12523, with the original start time
  `2026-09-04T15:15:44.2759031Z`.
- `/health` returned `healthy`; `/status` reported zero processing files.
- All 296 `dist` files matched the integrity reference. Aggregate SHA256:
  `7342af1c362755bc18616245cc75a7685c1a0ec6254b73d389d5a66e96e4a9bd`.
- Production configuration matched the integrity reference. SHA256:
  `294ffbacd77b3188310916ddb952eb17d0e1d6a9aadf7ca9ba478de26f882c01`.
- No PM2 restart/reload or compiled deployment was performed.

The aggregate digest recursively sorts directory entries by `name.localeCompare`
and hashes each repository-relative Windows path (including the `dist` directory) followed
by the file bytes. Source JS/Python helpers retain the original entrypoints and
take effect on future child invocations; compiled TS changes remain undeployed.

## Follow-up implementation

The next increment extracts local evidence acquisition into `comic/screenshots.py`.
It owns video discovery, duration probing, requested individual frames, reference
sheets, and one shared FFmpeg frame invocation. `ai_comic_generator.py` keeps
compatible entrypoints and resolves its existing injectable hooks at call time.
The module has no dependency on provider clients or application configuration.
The main comic file drops from 4,598 to 4,268 physical lines.

Validation: 75 focused comic tests passed, followed by the complete portable gate:
45 Jest suites / 479 tests, 227 Python tests, 4 Node tests, and 6 compiled workflow
tests. Added cases cover partial frame failure, partial sheet failure, resource
limits, and disabled acquisition. The real FFmpeg smoke generated a 960x540 frame
and a 1600x502 two-timestamp sheet, both decoded with nonblank pixel checks.
Local evidence is in `tmp/structure-phase1-verify.log` and
`tmp/structure-screenshot-smoke-7pn_md3u/`.

## Deployment (2026-09-06)

The user authorized replacing the existing PM2 runtime after the initial review.
Deployed application commit: `83a0fed0a82cd996971885fa3de6574f77d78582`, including
the initial structural change in `b30508b` and the screenshot extraction.

- Only `danmaku-webhook` was restarted. PID changed from 24112 to 132852 at
  `2026-09-06T07:24:13.8804714Z`; port remains 12523.
- The stop/swap/start/verification sequence took 4.69 seconds. This is a single
  fork-mode process, so the deployment includes a brief service restart.
- All 74 staged JavaScript modules matched the tested isolated output byte for
  byte. The release was staged at the same directory depth as `dist` to preserve
  source maps and the current history-path behavior.
- Delayed tasks, the summary queue, production configuration, and the existing
  external reply-history file had identical hashes before and after deployment.
  The service restored all 2,264 delayed-task records and their dedupe history;
  no tasks were pending or processing at the switch.
- Other PM2 process IDs and states were unchanged.
- `/health`, `/status`, `GET /api/delayed-reply/tasks`, and the registered
  `POST /mikufans` route (checked with `OPTIONS`) were verified. The new process
  remained healthy two minutes later with no new timestamped ERROR log entries.

The previous runtime and state snapshots are retained under
`build/deploy-backups/20260906T072409Z/`. The local `deployment.json` there records
the exact before/after hashes and process IDs. Source tests cover reconstruction
from later FileClosed events and nearby disk segments when an in-memory recording
session is lost on restart. No synthetic recording event or test comment was
submitted to the production workflow.

## Follow-up phases

There are four follow-up phases after the initial structural review. Each phase
can contain independently tested commits; completing one does not require
rewriting the whole pipeline at once.

1. Completed: comic screenshots, image routes and input assembly have explicit
   owners and injected provider dependencies, preserving metadata and fallbacks.
2. Completed: supplementary publication workflows have typed ports, durable
   publication intent and restart/retry tests; task locks remain with the service.
3. Completed increment: source CLIs load strictly typed stages from a complete,
   verified release. Request/response handling and ASR diagnostics have migrated;
   the remaining JS orchestration can follow this established release boundary.
4. Completed: Node/Python share a configuration contract; reply storage has a
   stable root and preserves the actual legacy history during migration.

### Phase 1: image generation boundaries

`comic/image_routes.py` owns provider configuration normalization, route ordering,
bounded attempts, and failure metadata through an injected `ImageRouteIO`.
`comic/image_inputs.py` owns identity-first reference assembly and provenance;
configuration/path/provider access stays in the compatibility facade.
Removed unused encoding and unreachable Google/Hugging Face implementations;
their permanently disabled entrypoints retain the original failure behavior.
`ai_comic_generator.py` decreased from 4,268 to 3,390 physical lines.

Validation: all 230 portable Python tests passed, including new route fallback,
recovery parameter forwarding, total failure and provider metadata cases.

### Phase 2: supplementary publications

`SupplementaryReplyWorkflow` owns comic follow-ups, separate live summaries,
summary-dynamic replies and their success notifications through typed ports.
The service retains task identity, locks, the scheduler and primary publication.
`DelayedReplyService.ts` decreased from 2,413 to 1,851 physical lines.

Comic and summary-dynamic requests now persist intent before sending, as separate
live summaries already did. Unfinished intent after restart stops automatic
resends. Successful publication cannot be reclassified as an API failure merely
because persistence or notification fails. The task store replaces its JSON file
atomically. Existing records do not require conversion.

Validation: 49 focused service/workflow integration tests passed, including six
new cases using actual temporary task files, restart recovery, retry, notification
failure and a simulated disk failure after publication.

### Phase 3: compiled TS stages

Added a strict workflow build, immutable release manifest, integrity-checked
compatibility bridge and separate candidate/activation pointers. Migrated text
request construction, response/usage parsing, and ASR process diagnostics to
typed modules. The entrypoints decreased from 2,235 to 2,010 lines (text) and
2,131 to 1,941 lines (summary). Scheduling and provider HTTP orchestration remain
in their compatible JS entrypoints for subsequent incremental migrations.

Validation: 28 text/provider/cache tests passed, two summary tests passed, and ten
Node tests passed. Release tests copy each CLI and the compiled package into a
temporary directory with no TS source or development dependencies, disable Node's
TS type stripping, and execute the runtime check. Compiled input/output checks
cover chat/responses, prompt caching, reasoning, usage and ASR timing sentinels;
an integrity test refuses a modified release.

### Phase 4: configuration and durable history

Node service/source CLIs share `ConfigLayers.ts`; Python uses the same JSON
contract through `config_contract.py`. Selected-file precedence, secret aliases,
environment overrides, BOM handling, array/null replacement and root resolution
have cross-language tests. Schema defaults remain with their runtime consumers.
The old duplicated secret mapping and merge routines were removed.

A production fingerprint comparison found all 1,351 existing Node CLI fields
unchanged. The service now receives the same provider/balance credentials already
used by Node CLIs. Python follows the selected production file and stops reviving
keys absent from it, including the deliberately empty anchor list. No production
configuration or secret file was edited.

Reply history now uses repository `data`, with source-preserving migration from
the actual legacy sibling path, backups, successful-record precedence and a
per-source import digest. Dates are restored for history sorting/cleanup. The
delayed-task store also uses a root independent of cwd. Twelve new tests cover
cross-language precedence and history migration/restart/failure behavior.

### Final migration verification

The complete gate passed after the final recovery hardening: 48 Jest suites,
498 tests, 230 portable Python tests, ten Node tests and seven compiled goodnight
workflow tests. The extra compiled/source test restores a future task from an
actual task file, preserves its identity/deadline, and publishes only once through
the mocked API. A repeated uncertain-summary recovery cannot resend or reattach
the same content. Log: `tmp/migration-release-verify.log`.

The real FFmpeg smoke passed with a five-second NVENC/CUDA subtitle clip,
two-stage copy, no fallback and 1,161 detected subtitle pixels. The new compiled
duration probe agreed with ffprobe. Log: `tmp/migration-media-smoke.log`.

### Four-phase deployment and production handover

The four-phase application release was pushed to `feature/use-sense-voice` and
deployed at `2026-09-06T08:46:03.7093316Z` (16:46 Asia/Shanghai). Deployed commit:
`b2f31d5704a676c7f459b423719289e86c274356`. The compiled workflow release is
`93e1ff652d21a9a05c7c`; all 79 staged JavaScript/JSON runtime files matched the
tested service output, and both source CLI runtime checks passed.

- Only `danmaku-webhook` was restarted, changing PID 132852 to 146404. Port 12523
  was preserved. The switch and verification took 6.63 seconds; this remains a
  brief restart of a single fork-mode process, not a zero-downtime deployment.
- All 2,266 delayed-task records were restored. The pending task retained its
  identity, status and scheduled deadline. The task file, summary queue,
  production configuration, external history and workflow pointer had identical
  hashes before and after the switch.
- All 16 legacy reply-history identities were preserved in repository `data`.
  The original sibling history remains intact, with migration backups and an
  import digest under `data/runtime/reply-history-migration/`.
- Other PM2 process IDs and states were unchanged. `/health`, `/status`, the task
  endpoint and the registered Mikufans route were verified after restart.

The real waiting task `5bdf05db-04a2-445b-9057-f65468c802cc` resumed automatically:
check 8 ran at `2026-09-06T08:47:25.731Z` and check 9 at
`2026-09-06T08:49:26.075Z`. The broadcaster's matching dynamic was still absent,
so the task remained pending with zero retries, no error and its next check at
`2026-09-06T08:51:26.075Z`. The new process remained healthy; there were no new
timestamped ERROR entries during this observation. This confirms production
scheduler handover; successful publication is covered by the mocked integration
tests, not by a synthetic production comment.

The old runtime, state snapshots and exact deployment report are retained under
`build/deploy-backups/20260906T084555Z/`. `tools/deploy-webhook.ps1` provides the
tested staging checks, pending-task deadline guard, history verification and
automatic runtime rollback if deployment verification fails.
