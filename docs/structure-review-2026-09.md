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

1. Comic generation (in progress): screenshot acquisition is extracted. Provider
   IO and image-input assembly remain in `ai_comic_generator.py`. Extract those
   with injectable provider/file dependencies, keeping current monkeypatch
   contracts and output metadata compatible. Acceptance includes provider-failure
   fallback, input identity, and generated-file metadata compatibility.
2. `DelayedReplyService.ts`: publication orchestration is still large. Preserve
   idempotency state, persistence ordering, and timer ownership while extracting
   supplementary-summary/comic workflows behind typed ports. Acceptance includes
   restart recovery and retries that cannot duplicate completed publications.
3. `enhanced_auto_summary.js` and `ai_text_generator.js`: migrate stages to TS
   after defining how source CLIs find a complete compiled release. Do not add a
   runtime dependency on a dev-only TypeScript transpiler. Acceptance includes
   executing each compatibility CLI from a production release without dev tools.
4. Configuration readers across Node/Python and historical operator scripts need
   further consolidation. The existing `ReplyHistoryStore` path depends on build
   depth; any correction must preserve the actual historical file, not silently
   start a new empty history. Acceptance includes preserving historical dedupe
   records and configuration parity across both runtimes. No persistent history
   path was migrated in either completed increment.
