# Post-Stream Media Replay

## Scope

Validate the already implemented resolution-probe reuse and shared GPU telemetry
against actual media, keeping the selected copy, source windows, encoding, subtitle
style, cover selection, and adaptive scheduling unchanged. This is media-stage
verification, not acceptance of the complete goodnight/comic/selection workflow.

The baseline loads `topic_clipper.js` and `ffmpeg_resource.js` from `3fd814e`.
The candidate uses source revision `54e1a38`. Other dependencies, the cover Python
script, and production configuration are shared. Six exported functions, including
cutting, SRT writing, subtitle styling, ASS writing, cover generation and temporary
cover-source cleanup, were compared and are identical. This is not a comparison
between two complete historical checkouts.

Only the previously authorized SUI recording windows and saved copy are used:

| Case | Start Seconds | End Seconds | Duration | SRT Rows |
| --- | ---: | ---: | ---: | ---: |
| 1 | 12305.979 | 12507.405 | 201.426s | 65 |
| 2 | 16083.329 | 16271.235 | 187.906s | 44 |
| 3 | 18414.080 | 18512.625 | 98.545s | 52 |

All 161 saved source rows match the current original SRT. The harness refuses
out-of-authorization windows and model-generation calls. Outputs stay under the
ignored repository `tmp/` tree. No upload registry, notification, model API,
AI image-generation API, or external media upload is invoked.

## Method

- Order: baseline, candidate, candidate, baseline; three clips per batch.
- Settings: `h264_nvenc`, `p4`, CQ 23, CUDA decode, two-stage `copy` burn,
  existing universal subtitle style and existing cover generator.
- The existing adaptive scheduler remains enabled. Every admitted job used the
  same idle profile and two FFmpeg threads; no fallback encoder was used.
- Batch timing starts after the initial resource snapshot and includes job
  scheduling, cutting, subtitle burn, cover generation and local result handling.
  Model selection, source readiness, ASR, goodnight, comic generation and posting
  are not included. A ready clip includes its cover.
- Subprocess instrumentation preserves `execFile`'s custom promisify behavior.
  Resolution counts cover the Node dimension probes; telemetry counts cover the
  Node peak-monitor GPU queries, not every subprocess used internally by Python.

## Results

| Batch | Variant | First Clip Ready | All Clips Ready | Resolution Probes | GPU Peak Queries |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Baseline | 61.723s | 107.100s | 3 | 128 |
| 2 | Candidate | 52.463s | 98.118s | 1 | 74 |
| 3 | Candidate | 52.920s | 96.000s | 1 | 74 |
| 4 | Baseline | 53.474s | 97.659s | 3 | 111 |

Mean all-clips time: 102.380s to 97.059s, about 5.2% lower in these batches.
Mean first-clip time: 57.599s to 52.692s, about 8.5% lower. Mean peak-query count:
119.5 to 74, about 38.1% lower, including the effect of differing run lengths.
All nine monitored stages in each batch had GPU samples and zero query errors.

Parent Node CPU time averaged 1.876s versus 1.438s. This excludes FFmpeg, Python,
PowerShell, nvidia-smi and other child processes; it is not total pipeline CPU.

The first baseline was noticeably slower. Filesystem warmth and background load
remain confounders; the last baseline was slightly faster than the first candidate.
Two samples per variant do not establish production latency non-inferiority,
P50/P95, or a guaranteed 5.2% speedup attributable to these changes.

## Media Integrity

For every case, all four MP4 files are byte-identical by SHA-256. The SRT files and
cover JPEGs are also byte-identical. Dimensions are 1920x1080, video is H.264 with
reported `r_frame_rate=60/1` and `yuv420p`, and audio is stereo AAC at 48 kHz. Actual container durations
match the locked durations above; subtitles begin at zero and remain within them.

The first baseline and first candidate completed full video/audio `framemd5`
decoding independently. Each case matches across them, including decoded frame
timing and audio packets. Once all MP4 hashes proved identical, redundant decoding
was deliberately stopped. Remaining copies reuse those verified complete checksums
only through matching full-file SHA-256, not through filenames or existence alone.

The native MP4 frame counts are 12,086, 11,275 and 5,913 respectively. The default
frame-synchronized `framemd5` export produced one fewer row per case; those
diagnostic row counts are not treated as native frame counts. Complete MP4 byte
identity, not the export's frame-sync behavior, is the primary full-stream proof.
Nine early/middle/late caption stills were extracted and inspected, including a
full-size long-caption sample. Captions were visible within the frame, without
edge clipping or overflow in these samples. This is an assistant visual check,
not independent human audio or semantic review.

The fixed case-2 cover wording already has a qualification-omission concern in
the earlier copy review. Preserving those bytes proves media equivalence, not
that this copy is accurate or approved for upload. ASR spellings were not changed.

## Evidence

- Run directory: `tmp/poststream-media-ab-20260907/2026-09-07T11-44-45-539Z/`.
- `result.json`: all four runs, settings, source references, subprocess calls,
  per-clip timing, GPU measurements and output paths.
- `verification.json`: media/SRT/cover hashes, decoded checksums, stream metadata,
  subtitle bounds, comparisons, visual samples and no detected integrity issues.
- `analysis.json`: recomputed summary, equality assertions and explicit limits.
- `visual-check/contact-sheet.jpg`: nine caption samples; full PNGs are alongside it.
- Harness: `tmp/poststream-media-ab-20260907.cjs`.
- Verification: `tmp/verify-poststream-media-ab-20260907.cjs`.
- Summary checks: `tmp/summarize-poststream-media-ab-20260907.cjs`.

No production source, configuration, service, compiled release pointer, or upload
queue was changed by this validation. The broader independent copy-quality and
complete-workflow latency gates remain open.
