"""Build and launch a minimal FunASR Paraformer fine-tune run."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


DEFAULT_BASE_MODEL = "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"


def hydra_path(value: str) -> str:
    return '"' + Path(value).as_posix() + '"'


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train-jsonl", required=True)
    parser.add_argument("--val-jsonl", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--base-model", default=DEFAULT_BASE_MODEL)
    parser.add_argument("--max-epoch", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--freeze-param", default="encoder")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        "python",
        "-m",
        "funasr.bin.train_ds",
        f"+model={args.base_model}",
        f"+train_data_set_list={hydra_path(args.train_jsonl)}",
        f"+valid_data_set_list={hydra_path(args.val_jsonl)}",
        f"+output_dir={hydra_path(args.output_dir)}",
        f"+init_param={args.base_model}",
        f"+dataset_conf.batch_size={args.batch_size}",
        "+dataset_conf.num_workers=0",
        f"+train_conf.max_epoch={args.max_epoch}",
        "+train_conf.accum_grad=1",
        "+train_conf.log_interval=20",
        "+train_conf.resume=false",
        f"+optim_conf.lr={args.lr}",
        "+scheduler_conf.warmup_steps=1000",
        f"+freeze_param={args.freeze_param}",
        "+device=cuda",
        "+ncpu=0",
        "+seed=42",
    ]

    (output_dir / "run_command.json").write_text(json.dumps(cmd, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"command": cmd}, ensure_ascii=False, indent=2))
    subprocess.run(cmd, check=True)


if __name__ == "__main__":
    main()
