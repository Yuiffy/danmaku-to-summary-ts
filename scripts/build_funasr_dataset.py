"""Build a FunASR fine-tune dataset from subtitle/audio pairs.

Outputs a directory containing:
  - wavs/*.wav
  - train.jsonl
  - val.jsonl
  - manifest.json

The script is intentionally standalone so it can be reused for future
subtitle exports without depending on project runtime code.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


DEFAULT_SOURCE_DIRS = [
    r"D:\files\videos\剪映输出\岁己2026年切片",
    r"E:\EFiles\Evideo\剪映输出-E\岁己2025年切片",
    r"D:\files\videos\剪映输出\岁己1毫米手指&看中单光一陷阱",
    r"D:\files\videos\剪映输出\栞栞shiori切片",
    r"D:\files\videos\剪映输出\瑞娅切片",
    r"D:\files\videos\剪映输出\梦魇tsuki切片",
    r"D:\files\videos\剪映输出\带鱼自己的切片",
]

DEFAULT_OUTPUT_DIR = r"D:\files\videos\剪映输出\asr训练集20260711_mix"
DEFAULT_SEED = 42
DEFAULT_VAL_RATIO = 0.1
MIN_SEG_SEC = 1.0
MAX_SEG_SEC = 30.0
MIN_TEXT_LEN = 2
MEDIA_EXTENSIONS = [".mp3", ".MP3", ".wav", ".WAV", ".m4a", ".M4A", ".mp4", ".MP4"]


@dataclass
class Sample:
    key: str
    wav: str
    text: str
    source_srt: str
    source_audio: str
    duration_sec: float


def clean_text(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\{[^}]+\}", "", text)
    text = text.replace("\n", " ").strip()
    text = re.sub(r"\s+", " ", text)
    return text


def parse_srt_time(ts: str) -> float:
    h, m, s = ts.split(":")
    s, ms = s.split(",") if "," in s else (s, "0")
    return int(h) * 3600 + int(m) * 60 + float(s) + float(ms) / 1000


def parse_srt(srt_path: Path) -> list[tuple[float, float, str]]:
    content = srt_path.read_text(encoding="utf-8-sig")
    segments: list[tuple[float, float, str]] = []
    blocks = re.split(r"\n\s*\n", content.strip())
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) < 3:
            continue
        time_line = None
        text_lines: list[str] = []
        for idx, line in enumerate(lines):
            if "-->" in line:
                time_line = line
                text_lines = lines[idx + 1 :]
                break
        if not time_line:
            continue
        match = re.match(r"(\d{2}:\d{2}:\d{2}[,.]\d+)\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d+)", time_line)
        if not match:
            continue
        start = parse_srt_time(match.group(1))
        end = parse_srt_time(match.group(2))
        text = clean_text(" ".join(text_lines))
        if not text or start >= end:
            continue
        segments.append((start, end, text))
    return segments


def find_audio_for_srt(srt_path: Path) -> Path | None:
    base = srt_path.with_suffix("")
    for ext in MEDIA_EXTENSIONS:
        candidate = Path(f"{base}{ext}")
        if candidate.exists():
            return candidate
    return None


def run_ffmpeg(args: list[str], timeout: int) -> None:
    result = subprocess.run(
        args,
        capture_output=True,
        timeout=timeout,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise RuntimeError(stderr[:500] or "ffmpeg failed")


def convert_to_wav(src_media: Path, wav_path: Path) -> None:
    run_ffmpeg(
        ["ffmpeg", "-y", "-i", str(src_media), "-ar", "16000", "-ac", "1", "-f", "wav", str(wav_path)],
        timeout=180,
    )


def cut_wav_segment(src_wav: Path, start: float, end: float, out_wav: Path) -> None:
    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-ss",
            str(start),
            "-t",
            str(end - start),
            "-i",
            str(src_wav),
            "-ar",
            "16000",
            "-ac",
            "1",
            "-f",
            "wav",
            str(out_wav),
        ],
        timeout=60,
    )


def iter_srt_files(source_dirs: list[Path]) -> list[Path]:
    srt_files: list[Path] = []
    for source_dir in source_dirs:
        if not source_dir.exists():
            print(f"[skip] source missing: {source_dir}")
            continue
        srt_files.extend(sorted(source_dir.rglob("*.srt")))
    return srt_files


def write_jsonl(samples: list[Sample], path: Path) -> None:
    with path.open("w", encoding="utf-8") as fh:
        for sample in samples:
            fh.write(
                json.dumps(
                    {
                        "key": sample.key,
                        "wav": sample.wav,
                        "text": sample.text,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )


def build_dataset(source_dirs: list[Path], output_dir: Path, val_ratio: float, seed: int, clean: bool) -> dict:
    wavs_dir = output_dir / "wavs"
    if clean and output_dir.exists():
        shutil.rmtree(output_dir)
    wavs_dir.mkdir(parents=True, exist_ok=True)

    all_samples: list[Sample] = []
    skipped_duration = 0
    skipped_text = 0
    skipped_missing_audio = 0
    ffmpeg_failures = 0
    per_source: dict[str, int] = {}

    srt_files = iter_srt_files(source_dirs)
    print(f"[info] discovered {len(srt_files)} subtitle files")

    for srt_path in srt_files:
        audio_path = find_audio_for_srt(srt_path)
        if audio_path is None:
            skipped_missing_audio += 1
            print(f"[skip] no audio pair: {srt_path}")
            continue

        segments = parse_srt(srt_path)
        if not segments:
            print(f"[skip] empty subtitles: {srt_path}")
            continue

        basename = srt_path.stem
        rel_source = str(srt_path.parent)
        per_source.setdefault(rel_source, 0)
        temp_wav = wavs_dir / f"_tmp_{basename}.wav"
        print(f"[file] {basename}: {len(segments)} segments")

        try:
            convert_to_wav(audio_path, temp_wav)
            for idx, (start, end, text) in enumerate(segments, start=1):
                duration = end - start
                if duration < MIN_SEG_SEC or duration > MAX_SEG_SEC:
                    skipped_duration += 1
                    continue
                if len(text) < MIN_TEXT_LEN:
                    skipped_text += 1
                    continue

                key = f"{basename}_{idx:04d}"
                out_wav = wavs_dir / f"{key}.wav"
                cut_wav_segment(temp_wav, start, end, out_wav)
                all_samples.append(
                    Sample(
                        key=key,
                        wav=str(out_wav),
                        text=text,
                        source_srt=str(srt_path),
                        source_audio=str(audio_path),
                        duration_sec=duration,
                    )
                )
                per_source[rel_source] += 1
        except Exception as exc:  # noqa: BLE001
            ffmpeg_failures += 1
            print(f"[error] {basename}: {exc}")
        finally:
            if temp_wav.exists():
                temp_wav.unlink()

    if not all_samples:
        raise RuntimeError("no usable samples generated")

    random.seed(seed)
    random.shuffle(all_samples)
    val_count = max(1, int(len(all_samples) * val_ratio))
    val_samples = all_samples[:val_count]
    train_samples = all_samples[val_count:]

    write_jsonl(train_samples, output_dir / "train.jsonl")
    write_jsonl(val_samples, output_dir / "val.jsonl")

    manifest = {
        "source_dirs": [str(path) for path in source_dirs],
        "output_dir": str(output_dir),
        "train_count": len(train_samples),
        "val_count": len(val_samples),
        "total_count": len(all_samples),
        "total_duration_sec": round(sum(sample.duration_sec for sample in all_samples), 3),
        "total_duration_hours": round(sum(sample.duration_sec for sample in all_samples) / 3600, 3),
        "skipped_missing_audio": skipped_missing_audio,
        "skipped_duration": skipped_duration,
        "skipped_text": skipped_text,
        "ffmpeg_failures": ffmpeg_failures,
        "per_source_sample_count": per_source,
        "seed": seed,
        "val_ratio": val_ratio,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build FunASR JSONL dataset from subtitle/audio pairs")
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--source-dir", action="append", dest="source_dirs", default=[])
    parser.add_argument("--val-ratio", type=float, default=DEFAULT_VAL_RATIO)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--clean", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source_dirs = [Path(path) for path in (args.source_dirs or DEFAULT_SOURCE_DIRS)]
    output_dir = Path(args.output_dir)
    manifest = build_dataset(source_dirs, output_dir, args.val_ratio, args.seed, args.clean)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
