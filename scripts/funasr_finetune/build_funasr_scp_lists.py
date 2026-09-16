"""Build official FunASR wav.scp and text.txt files from wav/text JSONL."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


OUTPUT_ENCODING = "gbk"


def normalize_key(key: str) -> str:
    key = key.replace("\t", " ").strip()
    key = re.sub(r"\s+", "_", key)
    key = key.replace("/", "_").replace("\\", "_")
    return key


def sanitize_text_for_gbk(text: str) -> str:
    text = text.replace("\t", " ").replace("\r", " ").replace("\n", " ").strip()
    text = re.sub(r"\s+", " ", text)
    return text.encode(OUTPUT_ENCODING, errors="replace").decode(OUTPUT_ENCODING)


def convert_split(src_jsonl: Path, wav_scp: Path, text_txt: Path) -> int:
    count = 0
    with src_jsonl.open("r", encoding="utf-8") as fin, wav_scp.open(
        "w", encoding=OUTPUT_ENCODING
    ) as fwav, text_txt.open("w", encoding=OUTPUT_ENCODING) as ftxt:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            key = normalize_key(item["key"])
            wav = item["wav"]
            text = sanitize_text_for_gbk(item["text"])
            if not key or not wav or not text:
                continue
            fwav.write(f"{key} {wav}\n")
            ftxt.write(f"{key} {text}\n")
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

    train_count = convert_split(
        input_dir / "train.jsonl",
        output_dir / "train_wav.scp",
        output_dir / "train_text.txt",
    )
    val_count = convert_split(
        input_dir / "val.jsonl",
        output_dir / "val_wav.scp",
        output_dir / "val_text.txt",
    )

    manifest = {
        "input_dir": str(input_dir),
        "output_dir": str(output_dir),
        "train_count": train_count,
        "val_count": val_count,
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
