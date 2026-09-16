# FunASR Fine-tune Scripts

This directory contains reusable helper scripts for the local FunASR Paraformer
fine-tuning workflow used in this project.

## Current model output

Usable trained model directory:

`D:/files/videos/asr_finetune_runs/paraformer_standard_20260712_official_example`

Preferred checkpoint for inference:

`model.pt.avg10`

## Scripts

- `build_funasr_dataset.py`: build wav/jsonl dataset from subtitle exports
- `prepare_funasr_train_jsonl.py`: convert wav/text dataset jsonl into FunASR train jsonl
- `build_funasr_scp_lists.py`: convert dataset jsonl into official `wav.scp` + `text.txt`
- `run_funasr_scp2jsonl.py`: call FunASR official `scp2jsonl` and normalize output to UTF-8
- `run_funasr_finetune.py`: legacy minimal training launcher kept for comparison
- `build_focus_finetune_subset.py`: build quick focused subsets for fast validation runs
- `run_funasr_official_example_train.py`: launch Paraformer training with official-style parameters
- `eval_paraformer_asr.py`: run ad-hoc evaluation and subtitle export
- `run_project_paraformer_review.js`: reuse project-standard segmented paraformer flow for review subtitles

## Notes

- Large datasets, checkpoints, eval clips, and rendered review files stay outside the repo.
- This folder is only for reusable helper scripts and docs.
- One-off local experiments should stay in `local-scripts/` or external output dirs.
