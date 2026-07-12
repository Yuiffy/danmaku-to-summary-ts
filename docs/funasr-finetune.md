# FunASR Paraformer Fine-tune Notes

## Current trained model

The current usable fine-tuned Paraformer model is:

`D:/files/videos/asr_finetune_runs/paraformer_standard_20260712_official_example`

Recommended checkpoint inside that directory:

`model.pt.avg10`

For production inference, use the prepared inference-ready directory:

`D:/files/videos/asr_eval/models/paraformer_official_avg10`

This directory already contains the full inference assets required by FunASR:

- `configuration.json`
- `config.yaml`
- `model.pt`
- `model.pt.best`
- `model.pt.avg10`
- `model.pt.ep*`

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

- `config/production.json` can use `model_profile = finetuned` when the prepared local inference directory exists on that machine
- current repository state keeps production on `default` again until the finetuned route is fully validated end-to-end
- when you want to retry the finetuned route locally, point `model_profile = finetuned` and use `D:/files/videos/asr_eval/models/paraformer_official_avg10`

Config entry:

`config.default.json` / `config.production.json`

```json
{
  "asr": {
    "paraformer": {
      "model_profile": "finetuned",
      "base_model": "paraformer-zh",
      "finetuned_model": "D:/files/videos/asr_finetune_runs/paraformer_standard_20260712_official_example"
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

The final successful run was:

`D:/files/videos/asr_finetune_runs/paraformer_standard_20260712_official_example`

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

Important:

- this retrain is still experimental
- production remains on the stable stock paraformer path for now
- the timestamp-base retrain is the next candidate for future finetuned rollout once checkpoints are validated end-to-end
