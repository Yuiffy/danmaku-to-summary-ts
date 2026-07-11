"""Run baseline or tuned Paraformer inference on one audio/video file."""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
from pathlib import Path

from funasr import AutoModel


def normalize_segments(result):
    if isinstance(result, list) and result:
        result = result[0]
    sentences = result.get("sentence_info") or []
    if sentences:
        normalized = []
        for item in sentences:
            start = item.get("start", 0)
            end = item.get("end", start)
            text = (item.get("text") or "").strip()
            if not text:
                continue
            normalized.append({
                "start_ms": start,
                "end_ms": end,
                "text": text,
            })
        return normalized
    text = (result.get("text") or "").strip()
    return [{"start_ms": 0, "end_ms": 0, "text": text}] if text else []


def probe_duration_ms(media_path: str) -> int:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            media_path,
        ],
        check=True,
        capture_output=True,
        encoding="utf-8",
    )
    return int(float(result.stdout.strip()) * 1000)


def split_text_into_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[。！？!?；;])", text)
    sentences = [part.strip() for part in parts if part.strip()]
    return sentences or ([text.strip()] if text.strip() else [])


def ensure_timed_segments(segments, total_duration_ms: int):
    if not segments:
        return []
    has_real_timestamps = any(seg.get("end_ms", 0) > seg.get("start_ms", 0) for seg in segments)
    if has_real_timestamps:
        return segments
    full_text = "".join(seg.get("text", "") for seg in segments).strip()
    sentences = split_text_into_sentences(full_text)
    if not sentences:
        return []
    total_units = sum(max(1, len(sentence.replace(" ", ""))) for sentence in sentences)
    cursor = 0
    timed = []
    for idx, sentence in enumerate(sentences, start=1):
        units = max(1, len(sentence.replace(" ", "")))
        if idx == len(sentences):
            end_ms = total_duration_ms
        else:
            end_ms = min(total_duration_ms, cursor + math.floor(total_duration_ms * units / total_units))
        if end_ms <= cursor:
            end_ms = min(total_duration_ms, cursor + 1500)
        timed.append({"start_ms": cursor, "end_ms": end_ms, "text": sentence})
        cursor = end_ms
    return timed


def wrap_text(text: str, max_chars_per_line: int) -> str:
    limit = max(1, int(max_chars_per_line))
    chars = list(text.strip())
    lines = []
    while chars:
        lines.append("".join(chars[:limit]))
        chars = chars[limit:]
    return "\\N".join(lines)


def calculate_subtitle_style(width: int, height: int, ratio: float = 0.05):
    min_font_size = 32
    max_font_size = 72
    font_name = "汉仪有圆 85简"
    font_size = min(max_font_size, max(min_font_size, round(height * ratio)))
    outline = max(2, round(font_size * 0.09))
    max_chars_per_line = max(12, math.floor(width / (font_size * 0.95)))
    return {
        "font_size": font_size,
        "outline": outline,
        "font_name": font_name,
        "max_chars_per_line": max_chars_per_line,
    }


def escape_ass_path_for_ffmpeg_filter(path: Path) -> str:
    text = str(path.resolve()).replace("\\", "/")
    if len(text) >= 2 and text[1] == ":":
        text = text[0] + "\\:" + text[2:]
    return text.replace("'", r"\'")


def ms_to_srt_time(ms: int) -> str:
    total_ms = max(0, int(ms))
    hours = total_ms // 3600000
    total_ms %= 3600000
    minutes = total_ms // 60000
    total_ms %= 60000
    seconds = total_ms // 1000
    millis = total_ms % 1000
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def write_srt(segments, srt_path: Path) -> None:
    lines = []
    for idx, seg in enumerate(segments, start=1):
        start_ms = seg.get("start_ms", 0)
        end_ms = seg.get("end_ms", 0)
        text = seg.get("text", "").strip()
        if not text:
            continue
        if end_ms <= start_ms:
            end_ms = start_ms + 2000
        lines.append(str(idx))
        lines.append(f"{ms_to_srt_time(start_ms)} --> {ms_to_srt_time(end_ms)}")
        lines.append(text)
        lines.append("")
    srt_path.write_text("\n".join(lines), encoding="utf-8")


def write_ass(segments, ass_path: Path, width: int, height: int) -> None:
    style = calculate_subtitle_style(width, height)
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Default,{style['font_name']},{style['font_size']},&H00FFFFFF,&H000000FF,&H00101010,&H64000000,-1,0,0,0,100,100,0,0,1,{style['outline']},0,2,48,48,36,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for seg in segments:
        text = wrap_text(seg["text"], style["max_chars_per_line"])
        lines.append(
            "Dialogue: 0,{start},{end},Default,,0,0,0,,{text}".format(
                start=ms_to_srt_time(seg["start_ms"]).replace(",", "."),
                end=ms_to_srt_time(seg["end_ms"]).replace(",", "."),
                text=text,
            )
        )
    ass_path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="paraformer-zh")
    parser.add_argument("--model-dir")
    parser.add_argument("--srt-output")
    parser.add_argument("--ass-output")
    parser.add_argument("--burn-output")
    parser.add_argument("--punc-model", default="ct-punc")
    parser.add_argument("--vad-model", default="fsmn-vad")
    parser.add_argument("--sentence-timestamp", action="store_true")
    parser.add_argument("--disable-punc", action="store_true")
    parser.add_argument("--disable-vad", action="store_true")
    args = parser.parse_args()

    model_kwargs = {
        "model": args.model_dir or args.model,
        "device": "cuda:0",
    }
    if not args.disable_punc:
        model_kwargs["punc_model"] = args.punc_model
    if not args.disable_vad:
        model_kwargs["vad_model"] = args.vad_model

    model = AutoModel(**model_kwargs)
    result = model.generate(input=args.audio, batch_size_s=30, sentence_timestamp=args.sentence_timestamp)
    total_duration_ms = probe_duration_ms(args.audio)
    segments = ensure_timed_segments(normalize_segments(result), total_duration_ms)

    payload = {
        "audio": str(Path(args.audio)),
        "model": args.model_dir or args.model,
        "segments": segments,
        "full_text": "".join(seg["text"] for seg in segments),
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.srt_output:
        srt_path = Path(args.srt_output)
        srt_path.parent.mkdir(parents=True, exist_ok=True)
        write_srt(segments, srt_path)
    ass_path = None
    if args.ass_output or args.burn_output:
        probe = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=p=0",
                args.audio,
            ],
            capture_output=True,
            encoding="utf-8",
        )
        if probe.returncode == 0 and probe.stdout.strip():
            width, height = [int(x) for x in probe.stdout.strip().split(",")]
        else:
            width, height = 1920, 1080
        ass_path = Path(args.ass_output) if args.ass_output else Path(args.burn_output).with_suffix(".ass")
        ass_path.parent.mkdir(parents=True, exist_ok=True)
        write_ass(segments, ass_path, width, height)
    if args.burn_output:
        burn_path = Path(args.burn_output)
        burn_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                args.audio,
                "-vf",
                f"ass='{escape_ass_path_for_ffmpeg_filter(ass_path)}'",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "18",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                str(burn_path),
            ],
            check=True,
        )
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
