# FunASR Paraformer Fine-tune Notes

## Current timestamp-capable fine-tuned model

Current training output directory:

`D:/files/videos/asr_finetune_runs/paraformer_timestamp_base_20260712_longrun`

Prepared inference-ready directory currently used by gray rollout:

`D:/files/videos/asr_eval/models/paraformer_timestamp_avg10`

This inference-ready directory contains the assets required by FunASR for rollout.

## Training checkpoint storage and optional cleanup

The experimental training checkpoints can be removed during a future space cleanup.
They are currently retained by the owner; they are not under automatic expiry.
The retained training runs total approximately **16.6 GiB** (measured 2026-10-07):

- `paraformer_standard_20260712_official_example`
- `paraformer_timestamp_base_20260712_longrun`

Their physical storage root is
`E:/EFiles/disk-archive/2026-10-07/files/videos/asr_finetune_runs`.
`D:/files/videos/asr_finetune_runs` is a directory junction to that root, so
deleting these checkpoints frees E space. Each run retains `model.pt`,
`model.pt.best`, `model.pt.avg10` and `model.pt.ep10`; epochs 1–9 were removed.

Before cleanup, check the effective deployment configuration and running training
or evaluation jobs. If any active model points into either training run, move that
consumer to its intended inference assets first. The separately prepared gray
rollout model at `D:/files/videos/asr_eval/models/paraformer_timestamp_avg10` is
still in use and is outside this cleanup scope.

Use the following PowerShell preview, then remove `-WhatIf` to delete the eight
named checkpoint files. Configurations, training commands, logs and evaluation
metadata remain available for rebuilding the experiment. Missing files are skipped
so a repeated cleanup is harmless; unexpected junctions or symbolic links abort.

```powershell
$ErrorActionPreference = 'Stop'
$checkpointRoot = 'E:\EFiles\disk-archive\2026-10-07\files\videos\asr_finetune_runs'
$runNames = @(
    'paraformer_standard_20260712_official_example'
    'paraformer_timestamp_base_20260712_longrun'
)
$weightNames = @('model.pt', 'model.pt.best', 'model.pt.avg10', 'model.pt.ep10')
$rootItem = Get-Item -LiteralPath $checkpointRoot
if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Expected the physical checkpoint root, not a link'
}
$weights = foreach ($runName in $runNames) {
    $runItem = Get-Item -LiteralPath (Join-Path $rootItem.FullName $runName)
    if ($runItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Unexpected link in training run'
    }
    foreach ($weightName in $weightNames) {
        $weightPath = Join-Path $runItem.FullName $weightName
        if (Test-Path -LiteralPath $weightPath -PathType Leaf) {
            $weight = Get-Item -LiteralPath $weightPath
            if ($weight.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Unexpected link in checkpoint file'
            }
            $weight
        }
    }
}
$weights | Select-Object FullName, Length
$weights | ForEach-Object { Remove-Item -LiteralPath $_.FullName -WhatIf }
```

## Project model selection behavior

The project now supports two Paraformer model profiles:

- `default`: upstream `paraformer-zh`
- `finetuned`: local fine-tuned model directory above

Repository-safe default:

- `config/default.json` uses `model_profile = default`
- `src/scripts/asr/asr_backends.js` keeps repository-safe defaults only:
  - `model_profile = default`
  - `base_model = paraformer-zh`
  - `finetuned_model = null`

Machine-local or deployment override:

- `config/production.json` keeps `model_profile = default` and applies finetuned rollout through `asr.gray_rollout`
- gray rollout currently uses `D:/files/videos/asr_eval/models/paraformer_timestamp_avg10`

Config entry:

`config.default.json` / `config.production.json`

```json
{
  "asr": {
    "paraformer": {
      "model_profile": "default",
      "base_model": "paraformer-zh",
      "finetuned_model": "D:/files/videos/asr_eval/models/paraformer_timestamp_avg10"
    }
  }
}
```

To temporarily switch back to the stock model, set:

```json
{
  "asr": {
    "paraformer": {
      "model_profile": "default"
    }
  }
}
```

## What worked

The successful path was:

1. Build `wav.scp` / `text.txt`
2. Use FunASR official `scp2jsonl`
3. Normalize generated `jsonl` back to UTF-8 on Windows
4. Train with the official Paraformer example-style parameters

The timestamp-capable retrain route is now the only recommended production candidate.

## Known improvements from this model

- `岁己` is now recognized correctly in cases where baseline often produced `睡几`
- overall Paraformer output is stable and no longer collapses into repeated tokens

## Remaining weaknesses

- game terms like `禁手` are still often recognized as nearby homophones
- long casual spoken tails can still drift

## Reusable scripts

Reusable fine-tuning helpers are stored in:

`scripts/funasr_finetune/`

These scripts are intended for future dataset rebuilds, official-format conversion,
training launches, and evaluation reruns.

## Timestamp-capable retrain route

The previous fine-tuned route improved text quality but did not integrate cleanly with
the current production timestamp/speaker pipeline.

To address that, a new retrain route is started from the timestamp-capable base model:

`iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch`

This model ships with:

- built-in VAD compatibility
- built-in punctuation compatibility
- timestamp-oriented production compatibility direction

Current retraining output directory:

`D:/files/videos/asr_finetune_runs/paraformer_timestamp_base_20260712_longrun`

Prepared inference directory currently used for gray rollout experiments:

`D:/files/videos/asr_eval/models/paraformer_timestamp_avg10`

Important:

- this retrain is still experimental
- production default remains on the stable stock paraformer path
- gray rollout is enabled separately:
  - room `26966466` (栞栞) -> 2% timestamp finetuned sampling
  - other rooms -> 1% timestamp finetuned sampling
- the older non-timestamp finetuned route should no longer be used for production rollout decisions
