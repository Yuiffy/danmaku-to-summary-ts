# Goodnight comic timeout incident

## Scope

- Requested recovery window, frozen at investigation start: 2026-09-07 23:02:42
  through 2026-09-08 02:02:42 Asia/Shanghai.
- Twelve completed goodnight tasks in that window; five had failed comics and
  no main-image or supplemental-image delivery receipt. The SUI task already
  had a supplemental image and was excluded.
- App evidence: `logs/pm2-combined-0.log`, the previous day's rotated log,
  `data/delayed_reply_tasks.json`, and each failed `_COMIC_FACTORY_META.json`.
- Gateway evidence: read-only queries of the local Sub2API PostgreSQL
  `usage_logs` and `ops_system_logs` tables. No account or balance was changed.

## Confirmed cause

The failure was in comic **text/script generation**, before image generation.
`comic/text_client.py` passed a 120,000 ms per-request deadline and a 240,000 ms
overall deadline to `ai_text_generator.js`. The Node fetch used
`AbortSignal.timeout`, which appeared as `The user aborted a request`.

All five original primary requests completed successfully at Sub2API after the
120-second client deadline. Access logs show HTTP 200 and usage logs contain
output token counts. Original comic failure metadata lacked request IDs, so
the matching uses the unique Node-owner start time (within 0.3 seconds), API
key ID 1, non-streaming node-fetch caller, and model `gpt-5.6-luna`.

| Room / Host | Node owner start, local | Sub2API usage ID | Duration | Output tokens |
| --- | --- | --- | --- | --- |
| 1727074031 / Chu2u | 00:21:21.133 | 108528 | 178.170 s | 5065 |
| 1727071052 / Viridis | 00:44:10.305 | 108562 | 180.718 s | 5122 |
| 21484828 / Joi | 01:06:29.914 | 108598 | 172.154 s | 4235 |
| 1791260716 / Mofu | 01:10:30.482 | 108633 | 190.481 s | 4730 |
| 23260993 / Rhea | 01:27:25.951 | 108685 | 123.076 s | 2947 |

The tuZi fallback also failed with timeouts, model-not-found, upstream errors,
or permission errors. Extending the primary wait avoids abandoning an active
successful request and unnecessarily entering that degraded fallback.

## Repair

Set `ai.comic.textGeneration` in both default and production configuration:

- `requestTimeoutMs`: 600000 (10 minutes).
- `totalTimeoutMs`: 1200000 (20 minutes including fallback).

The same key had other successful non-streaming high-reasoning text requests
as long as 377.342 seconds in the window. Ten minutes provides headroom over
those observations. Image timeouts, models, reasoning effort, generation
quality, retry counts, and the main-reply workflow were not changed by the
timeout repair. A separate identity correction is described below.

The existing Python process boundary derives its timeout from the configured
total plus five seconds. Recovery logs confirm `timeout=600000ms,
total=1200000ms`; new comic processes read these files without restarting the
webhook service or activating unrelated workflow builds.

## Recovery

The local one-off runner is
`local-scripts/one-off-scripts/2026-09-08-goodnight/recover.cjs`.
It freezes eligible task IDs and original receipts, preserves failure metadata,
uses original highlights and storytelling variants, checks image decoding,
and normally publishes through the existing localhost task-ID recovery endpoint.
After the identity mistake below, all corrected outputs additionally require
the production host reference in their image manifest and direct visual
comparison with that reference. The original main reply ID is unchanged.

Local audit artifacts are in `tmp/goodnight-recovery-20260908/`, including
`manifest.json`, per-task before/generated/published records, retry logs,
`sub2api-original-requests.json`, `sub2api-original-access.json`, and
`final-audit.json`. Final audit: all five have successful image metadata,
the correct host reference in their input manifests, a final publication
receipt, and unchanged main reply IDs.

| Task | Result | Supplemental reply |
| --- | --- | --- |
| 5319f637-331a-4600-a8ad-24a3a5fb8610 | Corrected and republished | 313278658689 |
| fb7aed5b-d5a8-4736-b418-e5bc946c0460 | Generated and published | 313278262417 |
| 7c7d0056-2428-46f7-bcab-0161cf683ed3 | Identity verified and published | 313278802193 |
| 1ef42ad7-d0d0-44a6-95d9-0a0ed3fde17e | Identity verified and published | 313278890993 |
| eb09a087-1642-429f-a4ab-53ca5c5bdf12 | Identity verified and published | 313278973153 |

At 02:13:26-02:13:35, three recovery attempts encountered a separate
`403 INSUFFICIENT_BALANCE` rejection. A subsequent read-only balance check
showed positive balance; those three were retried after that external change.

## Manual recovery identity mistake

The initial one-off recovery process did not set `NODE_ENV=production`.
The shared config contract defaults to development, selecting only
`default.json` rather than `production.json`. Mofu's reference image and
character description were only in production, so the recovery omitted her
host reference and inherited the SUI default description. The initial visual
check missed this identity error. The user deleted reply `313278186977` and
requested a replacement. This was a recovery mistake, not the cause of the
original timeout failures.

The runner now pins `NODE_ENV`, `CONFIG_PATH`, and `DANMAKU_PROJECT_ROOT`;
checks the host reference before generation; checks the actual image input
manifest afterwards; and requires visual identity review before publication.
Corrected scripts are generated in fresh staging directories, not reused from
the bad run. Reviewed images/scripts replace their canonical local artifacts;
superseded files are retained in the audit directory.

Known hosts lacking a room-specific description also inherited the SUI
default, even if their reference image was present in the registry. The
Python generator now prefers a registry character description and otherwise
uses the known host name with reference-only appearance instructions. Explicit
room descriptions retain priority. Unknown/no-room legacy fallback is unchanged.

The corrected Mofu script took 144.917 seconds at Sub2API (usage 108819), and
its image took 144.508 seconds (usage 108835). The input manifest contains
`mofu_standing_sheet.png` as the host; the reviewed image has brown-pink hair,
yellow/blue eyes, and the matching outfit. Corrected image and notice were
also sent successfully to WeChat Work.

The user-deleted Mofu supplement was replaced through the existing localhost
comment API. Its explicit replacement ledger is
`5319f637-331a-4600-a8ad-24a3a5fb8610.replacement.json`, including the deleted
reply ID and new receipt. The original task's historical supplemental ID is
retained rather than rewriting the live service's in-memory task store or
restarting production. The runner refuses to blindly repeat that replacement.

## Verification

- Python comic text-provider tests: 19 passed, including deployed deadlines
  reaching Node and its parent, and known-host identity precedence.
- Python comic multi-reference tests: 71 passed.
- Jest comic wrapper, delayed reply service, and supplementary reply workflow:
  3 suites, 46 tests passed. Publication APIs were mocked in these tests.
- `git diff --check`: passed for the incident changes.
- Live recovery and Bilibili receipts are tracked separately above; a unit
  test pass is not treated as evidence of publication.
