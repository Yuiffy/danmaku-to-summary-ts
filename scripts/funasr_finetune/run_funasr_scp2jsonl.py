"""Thin wrapper around FunASR official scp2jsonl utility.

Uses the library API directly to avoid Hydra quoting issues on Windows paths.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from funasr.datasets.audio_datasets.scp2jsonl import gen_jsonl_from_wav_text_list


def normalize_jsonl_to_utf8(path: str) -> None:
    file_path = Path(path)
    text = file_path.read_text(encoding="gbk")
    file_path.write_text(text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wav-scp", required=True)
    parser.add_argument("--text-txt", required=True)
    parser.add_argument("--output-jsonl", required=True)
    args = parser.parse_args()

    gen_jsonl_from_wav_text_list(
        [args.wav_scp, args.text_txt],
        data_type_list=["source", "target"],
        jsonl_file_out=args.output_jsonl,
    )
    normalize_jsonl_to_utf8(args.output_jsonl)


if __name__ == "__main__":
    main()
