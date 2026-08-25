# Clipping Modules

This directory contains reusable clipping and evidence-processing modules.

The broader placement rules for `src/scripts` are documented in
`src/scripts/README.md`. This directory is for shared clipping contracts and
adapters; a date-specific detector or a one-off compilation stays under the
ignored `temp/` tree until its inputs and behavior are made configurable.

## Layout

- `topic_compilation.js`: discover recordings, search SRT/XML evidence, build a
  reviewable cross-recording plan, and compile the selected windows.
- `event_manifest.js`: normalize detector output into one event contract and
  perform score-aware overlap selection.
- `resource_scheduler.js`: adaptive FFmpeg worker and thread scheduling.
- `output_path.js`: map archive recordings to the active output tree.
- `*.schema.json`: machine-readable contracts for detector/compiler boundaries.

The large Sui workflows in `src/scripts/topic_clipper.js`,
`src/scripts/own_stream_clipper.js`, and `src/scripts/manual_clip_queue.js`
remain at their historical paths for compatibility. New shared code belongs
here; the root files should depend on these modules instead of adding more
cross-workflow helpers.

`src/scripts/clip_resource_adaptive.js` and `src/scripts/clip_output_path.js`
are compatibility entrypoints. New imports should use this directory.

## Event contract

Detectors may use their own internal measurements, but the handoff to a
compiler should be a JSON object with `source.mediaPath` and canonical events:
`id`, `sourceId`, `start`, `end`, `duration`, `score`, `evidence`, and
`metadata`. Legacy detector fields such as `firstHit`/`lastHit` and
`peakScore` are accepted by `event_manifest.js` and normalized at the
boundary. A detector-specific ROI, waveform threshold, or template stays in
the detector adapter and does not belong in this shared module.
