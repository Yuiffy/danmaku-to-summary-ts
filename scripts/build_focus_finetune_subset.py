"""Build a focused subset for rapid ASR fine-tuning validation."""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path


KEYWORDS = [
    "岁己",
    "小岁",
    "栞栞",
    "shiori",
    "Shiori",
    "五子棋",
    "禁手",
    "连连看",
    "彩排",
    "BW",
    "直播间",
]


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def dump_jsonl(rows: list[dict], path: Path) -> None:
    with path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def is_focus_text(text: str) -> bool:
    lowered = text.lower()
    return any(keyword.lower() in lowered for keyword in KEYWORDS)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--general-train", type=int, default=800)
    parser.add_argument("--general-val", type=int, default=120)
    parser.add_argument("--focus-train-limit", type=int, default=0)
    parser.add_argument("--focus-val-limit", type=int, default=0)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    random.seed(args.seed)
    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    train_rows = load_jsonl(input_dir / "train.jsonl")
    val_rows = load_jsonl(input_dir / "val.jsonl")

    train_focus = [row for row in train_rows if is_focus_text(row.get("target", ""))]
    val_focus = [row for row in val_rows if is_focus_text(row.get("target", ""))]

    if args.focus_train_limit and len(train_focus) > args.focus_train_limit:
        random.shuffle(train_focus)
        train_focus = train_focus[: args.focus_train_limit]
    if args.focus_val_limit and len(val_focus) > args.focus_val_limit:
        random.shuffle(val_focus)
        val_focus = val_focus[: args.focus_val_limit]

    train_general = [row for row in train_rows if row not in train_focus]
    val_general = [row for row in val_rows if row not in val_focus]

    random.shuffle(train_general)
    random.shuffle(val_general)

    train_subset = train_focus + train_general[: args.general_train]
    val_subset = val_focus + val_general[: args.general_val]
    random.shuffle(train_subset)
    random.shuffle(val_subset)

    dump_jsonl(train_subset, output_dir / "train.jsonl")
    dump_jsonl(val_subset, output_dir / "val.jsonl")

    manifest = {
        "input_dir": str(input_dir),
        "output_dir": str(output_dir),
        "train_focus": len(train_focus),
        "val_focus": len(val_focus),
        "train_total": len(train_subset),
        "val_total": len(val_subset),
        "keywords": KEYWORDS,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
