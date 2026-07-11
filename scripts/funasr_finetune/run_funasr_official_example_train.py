"""Launch FunASR Paraformer training with parameters aligned to the official example."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


DEFAULT_BASE_MODEL = "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"


def hydra_str(value: str) -> str:
    return '"' + value.replace("\\", "/") + '"'


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-model", default=DEFAULT_BASE_MODEL)
    parser.add_argument("--train-jsonl", required=True)
    parser.add_argument("--val-jsonl", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--max-epoch", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=6000)
    parser.add_argument("--sort-size", type=int, default=1024)
    parser.add_argument("--num-workers", type=int, default=4)
    parser.add_argument("--validate-interval", type=int, default=2000)
    parser.add_argument("--save-checkpoint-interval", type=int, default=2000)
    parser.add_argument("--keep-nbest-models", type=int, default=20)
    parser.add_argument("--avg-nbest-model", type=int, default=10)
    parser.add_argument("--lr", type=float, default=2e-4)
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        "python",
        "-m",
        "funasr.bin.train_ds",
        f"++model={hydra_str(args.base_model)}",
        f"++train_data_set_list={hydra_str(args.train_jsonl)}",
        f"++valid_data_set_list={hydra_str(args.val_jsonl)}",
        '++dataset="AudioDataset"',
        '++dataset_conf.index_ds="IndexDSJsonl"',
        "++dataset_conf.data_split_num=1",
        '++dataset_conf.batch_sampler="BatchSampler"',
        f"++dataset_conf.batch_size={args.batch_size}",
        f"++dataset_conf.sort_size={args.sort_size}",
        '++dataset_conf.batch_type="token"',
        f"++dataset_conf.num_workers={args.num_workers}",
        f"++train_conf.max_epoch={args.max_epoch}",
        "++train_conf.log_interval=1",
        "++train_conf.resume=true",
        f"++train_conf.validate_interval={args.validate_interval}",
        f"++train_conf.save_checkpoint_interval={args.save_checkpoint_interval}",
        f"++train_conf.keep_nbest_models={args.keep_nbest_models}",
        f"++train_conf.avg_nbest_model={args.avg_nbest_model}",
        "++train_conf.use_deepspeed=false",
        f"++optim_conf.lr={args.lr}",
        f"++output_dir={hydra_str(args.output_dir)}",
    ]

    (output_dir / "run_command.json").write_text(
        json.dumps(cmd, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps({"command": cmd}, ensure_ascii=False, indent=2))
    subprocess.run(cmd, check=True)


if __name__ == "__main__":
    main()
