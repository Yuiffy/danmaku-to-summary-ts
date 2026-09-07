# Delayed Reply Timing Audit, 2026-09-07

## Incident Evidence

All times below are Asia/Shanghai (UTC+08:00).

- Room: `31368705` (Miting); UID: `2124647716`.
- Task: `b156fa47-e7ee-47ea-b805-c057d8a5a907`.
- Main reply: `313204011137`, on dynamic `1245034366844796937`.
- The stream ended at 11:09:56.638. Text was ready at 11:17:24.
- `logs/pm2-out-0.log:14388` records a random draw of `0.820 > 0.8`, explicitly skipping comic generation.
- The ready event therefore omitted the image path. The stored task has `comicImagePath: ""`; this is not evidence of a lost in-flight image.
- Ten two-minute checks found no dynamic in the current stream's target window. At 11:39:27 the service fell back to the latest existing dynamic, published at 02:49:13.
- The API was called without images and returned the main reply ID at 11:39:28.804. The task completed instead of waiting for a supplemental image.

The direct cause was configured random skipping, not a failed image upload or an urgent first-wave decision. The initial investigation's missing-path hypothesis was corrected after reading the generation log.

## Changes

- Set this room's production `comicGenerationProbability` from `0.8` to `1`. Other rooms, duration thresholds, and generation-failure fallback remain unchanged.
- Remove the five-poll text-first fallback for older dynamics. When an image is planned, wait for the actual file or a producer-reported failure, subject to the existing 24-hour task age limit. Continue looking for a genuinely fresh target during that wait.
- Only a qualifying target published within the last five minutes may bypass image waiting. A fallback target or a future timestamp is not a first-wave opportunity.
- Treat successful metadata without the output file as still waiting, because metadata can arrive before the image.
- Select dynamics by publication time instead of trusting feed order, which may put a pinned item first. Reject invalid and future publication timestamps.
- Serialize creation by room and text path, merge late image intent into the same task, and preserve its creation time and polling history. A late text-only event cannot create another task for an already completed recording.
- Persist whether the successful main reply contained an image. Process-close events no longer request an extra comic after a combined reply. Explicit recovery and supplemental execution also respect that receipt.
- Preserve image-ready events received during a main publication and continue with a supplemental image when required.
- Honor explicit `delaySeconds` even when a fresh dynamic is available.
- Check task age before active-live deferral, so an expired task cannot keep extending itself.
- Persist main-publication stages before sending. Restore an interrupted `ready` stage; stop automatic resending for an interrupted `publishing` stage or an ambiguous legacy `processing` task. Subsequent ready events do not recreate an unknown-outcome task.
- Once a main receipt exists, subsequent failures retry follow-up work only. A failure to persist that receipt leaves the durable publishing marker for restart recovery.
- A supplemental wait timeout still ends that wait, but no longer overwrites the image producer's metadata with a fabricated generation failure.

Dynamic lookup was moved to the existing delayed-reply helper directory to keep the service within its frozen line budget. Unrelated worktree changes and workflow-release activation were left alone.

## Verification

- Existing focused baseline: 46 tests passed before changes.
- New timing suite: 22 tests. The original implementation reproduced the old-dynamic early-send, duplicate-event, feed-order, expiry, metadata-overwrite, and restart failures; two further tests reproduced explicit-delay bypass and in-flight image-event loss before their fixes.
- `npm test -- --runInBand --silent`: 72 suites, 767 tests passed.
- `npm run type-check`, `npm run build:check`, and `npm run build:isolated`: passed.
- Compiled integration tests: 7 passed with `tests/jest.compiled.config.cjs`.
- `git diff --check`: passed.
- `npm run architecture:check`: failed only for unrelated concurrent ASR edits, `audio_processor.js` (1622/1496 lines) and `sensevoice_speaker.py` (2388/2331 lines). This change's service remains within its 1851-line budget.

## Deployment

- Verified zero processing files, zero active delayed replies, and no webhook child processes before restart.
- Used the TypeScript compiler to emit only six changed reply modules and their generated maps/declarations into `dist`. Their JavaScript hashes match the isolated tested build.
- Previous emitted files are backed up under `tmp/delayed-reply-deploy-2026-09-07T03-59-58-242Z`.
- Restarted only `danmaku-webhook` around 12:00:16. Other PM2 services were not restarted.
- `/health` returned `healthy`; `/status` reported running on port `12523`. Startup restored 2292 historical tasks and zero pending tasks.
- The incident task and original comment were not changed, regenerated, supplemented, or reposted.

Verification used mocked publication APIs and a real local task store. No real Bilibili comment was sent as a test. Future live-stream delivery has not yet been observed under the new code. For legacy completed tasks with an image path but no delivery receipt, automatic recovery is conservative; explicit review is needed before deciding to send another image.

## Follow-Up: Full Generation Configuration

The global production default was already 100%; the incident came from Miting's stale room-level 80% override taking precedence. The effective production configuration has now been audited across all rooms: all 38 enabled rooms resolve to probability `1` and minimum comic duration `0`. The three explicitly disabled rooms remain disabled.

At the user's request, the configurable sampling mechanism is retained for possible future use. The temporary removal was undone; only the stale override correction and regression coverage are kept. Tests execute the actual settings resolver and generation branch, checking both the current all-room 100% configuration and intentional future global or room-level sampling. Changing the production policy later should update the corresponding configuration assertion deliberately.
