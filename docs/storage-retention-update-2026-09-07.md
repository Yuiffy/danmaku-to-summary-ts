# Storage retention changes, 2026-09-07

## Completed actions

The user authorized comparison against E, recycling redundant review media,
deleting backups at successful audio conversion, and fixing long conversions.
The user explicitly requested that the 24-hour scan interval remain unchanged.

| Action | Result |
| --- | --- |
| Review recordings inspected | 37 videos plus the preserved manifest |
| Confirmed replacements recycled | 24 files, 282.514 GiB |
| Unverified/different versions retained | 13 files, 54.687 GiB |
| Old converted-room backups deleted | 186 directories, 428.987 GiB |
| Long recording verification | 11.5-hour recording converted in 365.074 seconds |
| D free after actions and ongoing normal retention | 622.47 GiB, 16.71% |
| Scan interval | 24 hours, unchanged |

The earlier 341.847 GiB figure combined all nonstandard Sui directories.
The actual `_review_redundant_2026-04` directory was 337.202 GiB in 38 files.
Manual clips and other nonstandard directories were not part of recycling.

## E archive comparison and recycling

All candidates were probed for streams, duration and size. Two same-size MP4
copies were verified with full SHA-256 hashes. Other accepted replacements
matched three FFmpeg Chromaprint audio samples, with inferred beginning/end
coverage within a 2-second container tolerance. Fingerprint checks establish
sampled recording identity, not byte identity or a full-frame integrity test.

Files with insufficient fingerprints, unmatched names, or inferred missing
beginnings/endings were kept, even when E contained the same named livestream.
The retained substantial versions include April 4, April 6 afternoon,
April 17 afternoon, April 19 evening, and April 27 afternoon. The full per-file
retained list and reasons are in `review-fingerprint-check.json` below.

Windows IFileOperation was used with `FOFX_RECYCLEONDELETE` and early failure;
there was no permanent-delete fallback. Every recycled file was checked against
its Windows `$I` record and recoverable `$R` file, including original path and
size. All 24 E replacements still existed after recycling. The manifest and
the 13 unverified D videos were preserved.

D's default recycle capacity was insufficient for this batch. With approved
execution, the D-volume limit was set to 299606 MiB (292.584 GiB), allowing the
new files and existing contents to remain recoverable. Nothing was emptied.
Recycling on D does not itself release D capacity. Most immediate space relief
came from the separately authorized backup deletion, not from recycling.

## Backup policy

Production now enables `audio.storage.deleteBakAfterConversion`.
It uses the existing 3-day conversion threshold; no separate 7-day schedule
or shorter scan interval was introduced.

At the end of the audio conversion phase, an audio-only date directory can
lose its old `bak` directories only when no unconverted root media remains,
its merged target audio passes stream/duration checks, and the backup contents
are old enough. Remaining failed/unreadable source media, fresh backup entries,
missing merged audio, failed validation and reparse points prevent this early
cleanup. Existing converted dates are also eligible, so the prior backlog is
handled. The standard archive-time pruning remains in place.

Video-retaining rooms, including Sui, do not enter this audio-conversion cleanup;
their existing archive-time backup policy is unchanged. No arbitrary nested
review/manual directories or unrelated scratch roots were added to deletion.

A `--backups-only` maintenance flag was added to avoid starting new conversions
or cross-drive archives when clearing an already converted backlog. The one-off
pass removed 460621462884 bytes across 186 directories, with zero failures,
zero video conversions and zero archives. These backup deletions are permanent,
as in the existing automated backup-pruning policy.

Implementation: `src/scripts/audio_processor.js:726`; production switch:
`config/production.json:126`. Schema and TypeScript configuration contracts
were updated without changing unrelated settings.

## Conversion timeout

The real conversion path now derives its timeout from input duration. The
budget is the maximum of five minutes, the positive configured FFmpeg timeout,
and input duration divided by 20 plus two minutes. It is bounded by Node's
timer limit. This preserves a finite timeout while accommodating long sources
and low process priority. The configured timeout acts as a minimum budget.

On timeout the code waits for the child to close before allowing failure cleanup
to remove its temporary output, preventing a writer/cleanup race.

The August 28 Nana7mi source (41522.661 seconds) produced a 230454792-byte Opus
file in 365.074 seconds and passed the existing duration comparison. The old
300-second hard limit would have killed this run. The explicit validation pass
preserved its source video; subsequent normal retention handles source removal.

Implementation: `src/scripts/audio_processor.js:233` and line 547.

## Deployment and verification

`danmaku-webhook` was restarted after its processing queue was found idle.
PID 136808 started the updated scheduler; its log reports `every 24 hours`.
The regular retention pass continues through the existing background service.
The one-off validation, backup-only pass and recycling jobs all completed.

- 74 tests passed across retention, conversion lifecycle, configuration layers,
  configuration provider and Webhook service suites.
- `npm run type-check` passed.
- Changed-code whitespace checks passed.
- No unrelated worktree edits were reverted.

## Evidence and recovery

All execution evidence is under `temp/storage-audit-20260907/`:

- `review-verification.json`: source and E ffprobe metadata.
- `review-fingerprint-check.json`: authoritative full-hash/fingerprint results.
- `recycle-results.json`: original, E replacement, `$I`, and `$R` paths per file.
- `recycle-capacity-change.json`: D-volume recycle capacity change.
- `recycle-execution.log`: native recycle and recovery checks.
- `backup-cleanup-execution.log`: permanent backup-only deletion counters.
- `long-conversion-result.json`: completed live conversion result.
- `updated-retention-dry-run.log`: pre-execution candidate snapshot.

`review-content-check.json` was an exploratory waveform comparison, explicitly
invalidated and not used for deletion. Do not use it as the comparison manifest.

The 24 recycled recordings can be restored from Windows Recycle Bin. Do not
lower the D recycle capacity below its retained contents without first deciding
which files should remain recoverable.
