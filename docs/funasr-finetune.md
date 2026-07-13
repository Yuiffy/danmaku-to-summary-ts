# FunASR Paraformer Fine-tune Notes

## Current timestamp-capable fine-tuned model

Current training output directory:

`D:/files/videos/asr_finetune_runs/paraformer_timestamp_base_20260712_longrun`

Prepared inference-ready directory currently used by gray rollout:

`D:/files/videos/asr_eval/models/paraformer_timestamp_avg10`

This inference-ready directory contains the assets required by FunASR for rollout.

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
  - room `26966466` (栞栞) -> 100% timestamp finetuned model
  - other rooms -> 10% timestamp finetuned sampling
- the older non-timestamp finetuned route should no longer be used for production rollout decisions
