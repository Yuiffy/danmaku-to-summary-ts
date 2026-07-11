"""Convert wav/text JSONL into FunASR training JSONL with source/target fields."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def convert_file(src: Path, dst: Path) -> int:
    count = 0
    with src.open("r", encoding="utf-8") as fin, dst.open("w", encoding="utf-8") as fout:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            wav = item["wav"]
            text = item["text"].strip()
            if not wav or not text:
                continue
            record = {
                "source": wav,
                "target": text,
                "prompt": "<ASR>",
                "source_len": 1,
                "target_len": max(1, len(text)),
            }
            fout.write(json.dumps(record, ensure_ascii=False) + "\n")
            count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    train_count = convert_file(input_dir / "train.jsonl", output_dir / "train.jsonl")
    val_count = convert_file(input_dir / "val.jsonl", output_dir / "val.jsonl")

    manifest = {
        "input_dir": str(input_dir),
        "output_dir": str(output_dir),
        "train_count": train_count,
        "val_count": val_count,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
