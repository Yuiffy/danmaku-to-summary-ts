# Storage retention audit, 2026-09-07

Follow-up execution and the corrected holding-directory breakdown are recorded
in `docs/storage-retention-update-2026-09-07.md`. This document describes the
earlier read-only audit, before the user authorized changes and cleanup.

## Scope and conclusion

Read-only inspection of the production retention configuration, PM2 status,
retained service logs, D-drive file metadata, and the configured E-drive archive.
No production code/configuration was changed, no service was restarted, and no
recording was converted, moved, or deleted by this audit.

The three retention operations are running. The main space problems are an
unmanaged review holding directory and the 33-day lifetime of raw backups, not
a general failure of the scheduler. There are also repeat conversion failures
and no general implementation of the configured temporary-file cleanup.

All sizes below are GiB (2^30 bytes). Directory totals are logical file sizes,
not guaranteed reclaimable allocation. These are live, non-atomic snapshots.

## Capacity and execution evidence

| Measurement | Result |
| --- | ---: |
| D free at beginning | 146.87 GiB, 3.94% |
| D free at later check | 177.57 GiB, 4.77% |
| E free at beginning | 2804.15 GiB |
| E free at later check | 2776.36 GiB |
| Managed recording root on D | 1943.420 GiB, 39390 files |
| Configured recording archive on E | 10946.990 GiB, 47051 files |
| Other directories under D:/files/videos | 339.612 GiB |

Free space changed during the inspection; that change was not caused by an
actual cleanup invocation from this audit. The archive inventory alone does
not identify the cause of the changing drive totals.

PM2 reported `danmaku-webhook` online, PID 146404, started on September 6 at
16:46 local time. The production service starts retention at startup and then
every 24 hours. The latest completed scan in the inspected log was around
September 6, 17:01 local time. The next scheduled run is approximately
September 7, 16:46, provided the service is not restarted.

The retained combined logs contain 11 completion records: 644 conversions,
101 archived date directories, 95 pruned videos, 24 pruned clip directories,
and 18 failure events, including repeat failures of the same sources. No
archive-directory failure was found. The `deleted=0` summary field does not
mean source videos were kept: successful conversions unlink the source and
increment `converted`, while archive pruning has separate counters.

Evidence: `logs/pm2-combined-0__2026-09-07_00-00-05.log`, completion records at
lines 1477, 27253, and 29111; scheduler startup at line 28637.

## Effective policy

- Audio-only rooms: convert media to 48 kbps Opus after 3 days, measured from
  file modification time; validate output duration before deleting the source.
- All recognized room/date directories: archive after 33 full days following
  the recorded date, using the production `audio.storage.archiveTargetBasePath`.
  The exact Unicode path is retained in the JSON evidence.
- `includeBak=false`: do not convert raw backup directories.
- `deleteBakBeforeArchive=true`: delete backups only immediately before archive.
- Sui is intentionally not audio-only. Its full recording stays as video;
  non-merged/repeated video candidates and nested videos are pruned at archive.
- Other rooms' `topic_clips` directories expire at archive.
- `maxFileAgeDays=null`: no blanket age-based deletion of retained media.

The authoritative values are `config/production.json:121`. Runtime behavior
is in `src/scripts/audio_processor.js:1176` and
`src/services/webhook/WebhookService.ts:83`.

## Findings

### 1. Review holding area is outside date-directory discovery

The nonstandard room layouts collectively contain 168 files totaling
341.847 GiB. Of these, `25788785_.../_review_redundant_2026-04` contains
38 files totaling 337.202 GiB, including 68.285 GiB of backups. Its `manifest.txt` was created
on June 2 and explicitly labels this as a review move. Its recordings span
21 dates in April.

`collectArchivableDayDirectories` only recognizes `root/room/YYYY_MM_DD`;
the extra holding-directory level is never an archive candidate
(`src/scripts/audio_processor.js:910`, date check at line 939).

All 21 dates have corresponding E-archive directories, but this is not proof
that the held files are duplicates or that the archive is complete. For
example, some corresponding dates contain only small sidecars. Do not delete
the holding area based on its name or destination-directory existence.

Recommended first action: preserve the holding area and its review status in
a separately named E-drive location. Copy, verify a file manifest/checksums,
check active references, and only then remove the D copy. This can release
about 337.2 GiB without choosing which recording version to discard.

### 2. Backup cleanup is delayed until day 33

Total D recording backups: 754.522 GiB. Excluding the holding area above,
standard date directories contain 686.237 GiB of backups. Of these,
2364 files totaling 551.422 GiB are at least 7 days old.

All of those older standard backups have a merged media sibling in their
date directory. Only sibling existence was checked, not complete segment
coverage, media integrity, or active task references. The 551.422 GiB is a
review candidate total, not an unconditional deletion allowance.

The current behavior is intentional in code: backup traversal is excluded
at `src/scripts/audio_processor.js:1054`, and backup removal is only invoked
by `archiveDayDirectory` at line 899. The merger moves raw segments into
`bak` after merging (`src/services/webhook/FileMerger.ts:722`).

Recommended policy: a separate 7-day backup lifetime after verified successful
merge/conversion. Preserve subtitle/XML evidence, active queue references,
unverified sources, and explicitly pinned files. This requires implementation;
setting `includeBak=true` would transcode backups, not implement this policy.

The holding-area migration and these standard backup candidates do not
overlap: combined potential D relief is approximately 888.624 GiB.

### 3. Long recordings repeatedly hit a hard-coded five-minute timeout

Two surviving Nana7mi merged recordings total 9.126 GiB:

| Recording date | Source duration | Size |
| --- | ---: | ---: |
| 2026-08-28 | 41522.661 s, about 11.5 h | 4.487 GiB |
| 2026-09-02 | 36402.562 s, about 10.1 h | 4.638 GiB |

Both have AAC audio streams according to a fresh ffprobe check. Logs repeatedly
report `ffmpeg` timeout at 300000 ms for these exact sources.
`runFfmpegCommand(args, timeout = 300000)` is defined at
`src/scripts/audio_processor.js:233`; the effective conversion calls it without
an override at line 527. Changing `audio.ffmpeg.timeout` alone will not fix
this path. The dry-run probes inputs but does not exercise real conversion.

Recommended fix: honor an explicit retention timeout and/or compute a bounded
duration-aware budget with stalled-progress detection. Preserve the source on
failure, record failures by source, and alert on repeated failure. Keep audio
validation and low resource priority.

### 4. Generic temporary-file cleanup is not implemented

`storage.cleanup` is present in configuration/schema, but no consumer of its
enabled/interval/maxAge settings was found in the source. This does not affect
the separate Opus-temporary cleanup already present in the retention worker.

The repository's `tmp` directory occupies 49.958 GiB; the configured recording
root's `temp` directory occupies another 2.187 GiB. The repo `tmp` is not the
same path as `storage.tempPath`.

Examples of old, single-link scratch data: `tmp/srt_rerun_sensevoice`
(10.376 GiB), `tmp/srt_rerun` (10.371 GiB), and
`tmp/clip-burn-benchmark-20260825` (9.196 GiB). These examples were all more
than 7 days old by file mtime. Retain research results and active tasks until
reviewed; do not recursively wipe `tmp` on age alone.

Recommended policy: explicit scratch roots, task completion metadata, a
7-day lifetime for reproducible scratch media, and exclusion of active jobs,
pinned assets, source files, and external references.

## Dry-run and backlog classification

The production-config dry-run scanned 3923 media files and proposed:

- 83 conversions, 15 date-directory archives, and 2 stale temporary removals.
- 15 archive-pruned videos (5.144 GiB) and 5 clip directories (0.009 GiB).
- No real media writes; `failed=0` means the dry-run itself completed.

The 15 archive candidates are all August 4 directories newly reaching 33 days,
totaling 38.898 GiB. No normal-layout directory aged 34 days or more remained.
Thus the regular archive scan is keeping up within its daily interval.

Metadata found 152 potential conversion-age media files (60.927 GiB); 69 were
rejected by the media probe (2.826 GiB). The other 83 match the dry-run count.
Most newly eligible inputs crossed the three-day threshold after the last
scheduled run; they should not all be labeled failures.

One rejected source alone is 2.797 GiB and has negative FLV-reported duration.
Invalid duration is not proof of an empty file. Preserve such files for
recovery or quarantine instead of automatically deleting them.

## Strategy choice

Prioritize the holding-area migration, independent verified backup expiry,
long-conversion timeout fix, and managed scratch cleanup. Keep the three-day
video window initially. There is no immediate need to shorten every full
recording's 33-day retention if these higher-value changes are made.

If faster full-directory archive is later desired, snapshot estimates are:

| Archive threshold | D bytes in eligible normal date directories |
| --- | ---: |
| 33 days, current | 38.898 GiB |
| 21 days | 486.101 GiB |
| 14 days | 752.082 GiB |
| 7 days | 1108.300 GiB |

These thresholds overlap each other and the backup candidates; do not add
their totals. They are directory eligibility estimates, not simulated
successful conversions/copies. Shorter archive also advances existing clip
deletion, so separate those lifetimes before changing the global threshold.

Add capacity-based alerts and a non-overlapping scan every 4-6 hours, with a
last-success timestamp, bytes freed/moved, overdue bytes, and failed-file
details. A reasonable initial D alert threshold is 300 GiB, with a recovery
target of 500 GiB; tune using measured daily recording volume. Do not use disk
pressure to bypass source-integrity and active-job checks.

E has historical backup candidates too: 182.440 GiB in 90 files. The current
worker does not sweep the E archive. This is a secondary review task, not a
reason to automatically reprocess preserved archive recordings.

Other substantial D consumers outside recording retention include QQ data
(285.78 GiB), editing exports (168.19 GiB), and ASR training runs (61.40 GiB).
They were inventoried, not selected for deletion.

## Verification and evidence

- Existing retention helper tests: 12/12 passed.
- Actual retention dry-run completed with the production configuration.
- ffprobe inspected both repeat-timeout sources without transcoding them.
- D inventory: 3394398 file entries, links not followed; hard-link-adjusted
  readable total 3532.138 GiB. Ten restricted paths were not enumerable,
  mostly system/recycle locations and one repo scratch directory. Recording
  source paths had no enumeration errors.
- E recording-archive inventory: 47051 files, zero enumeration errors.
- Full metadata and analysis are under `temp/storage-audit-20260907/`:
  `drive-d-inventory.json`, `archive-e-inventory.json`, `analysis.json`, and
  `retention-dry-run.log`. The helper scripts only inventory/analyze files.

No end-to-end actual conversion, deletion, or cross-drive move was executed
as part of this inspection. All proposed destructive cleanup requires a
verified candidate manifest and an explicitly authorized execution pass.
