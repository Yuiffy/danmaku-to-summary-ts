"""Benchmark the repository's Paraformer, SenseVoice, and Fun-ASR-Nano backends."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import re
import subprocess
import sys
import threading
import time
import wave
from collections import Counter
from pathlib import Path


MODEL_PAYLOADS = {
    "paraformer": {
        "backend": "paraformer",
        "model": "paraformer-zh",
        "vad_model": "fsmn-vad",
        "punc_model": "ct-punc",
        "language": "auto",
        "vad_device": "cpu",
        "use_itn": True,
        "vad_max_single_segment_time_ms": 60000,
        "batch_size_s": 600,
        "batch_size_threshold_s": 60,
    },
    "sensevoice": {
        "backend": "sensevoice",
        "model": "iic/SenseVoiceSmall",
        "vad_model": "fsmn-vad",
        "punc_model": "ct-punc",
        "language": "auto",
        "use_itn": True,
        "max_vad_segment_s": 8,
        "asr_max_segment_s": 8,
        "merge_length_s": 8,
        "batch_size_s": 300,
    },
    "fun_asr_nano": {
        "backend": "fun_asr_nano",
        "model": "FunAudioLLM/Fun-ASR-Nano-2512",
        "vad_model": "fsmn-vad",
        "punc_model": None,
        "language": "中文",
        "use_itn": True,
        "max_vad_segment_s": 8,
        "asr_max_segment_s": 8,
        "merge_length_s": 8,
        "batch_size_s": 300,
    },
}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="16 kHz mono WAV input")
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--device", default="cuda", choices=("cuda", "cpu"))
    parser.add_argument(
        "--models",
        nargs="+",
        choices=tuple(MODEL_PAYLOADS),
        default=list(MODEL_PAYLOADS),
    )
    parser.add_argument("--window-s", type=int, default=30)
    parser.add_argument("--timeout-s", type=int, default=7200)
    return parser.parse_args()


def audio_duration_s(path):
    with wave.open(str(path), "rb") as audio:
        return audio.getnframes() / audio.getframerate()


def format_srt_time(seconds):
    milliseconds = max(0, round(float(seconds) * 1000))
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    secs, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{milliseconds:03d}"


def write_srt(path, segments):
    lines = []
    for index, segment in enumerate(segments, 1):
        lines.extend([
            str(index),
            (
                f"{format_srt_time(segment.get('start', 0))} --> "
                f"{format_srt_time(segment.get('end', 0))}"
            ),
            str(segment.get("text", "")).strip(),
            "",
        ])
    path.write_text("\n".join(lines), encoding="utf-8")


def normalized_characters(text):
    return re.sub(r"[\W_]+", "", str(text or "")).lower()


def levenshtein_distance(left, right):
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for left_index, left_char in enumerate(left, 1):
        current = [left_index]
        for right_index, right_char in enumerate(right, 1):
            current.append(min(
                current[-1] + 1,
                previous[right_index] + 1,
                previous[right_index - 1] + (left_char != right_char),
            ))
        previous = current
    return previous[-1]


def character_similarity(left, right):
    left = normalized_characters(left)
    right = normalized_characters(right)
    scale = max(len(left), len(right))
    if not scale:
        return 1.0
    return max(0.0, 1.0 - levenshtein_distance(left, right) / scale)


def segments_in_window(segments, start, end, include_emotion=False):
    values = []
    for segment in segments:
        if float(segment.get("start", 0)) >= end or float(segment.get("end", 0)) <= start:
            continue
        prefix = ""
        if include_emotion and segment.get("emotion"):
            prefix = f"[{segment['emotion']}]"
        values.append(f"{prefix}{str(segment.get('text', '')).strip()}")
    return " ".join(value for value in values if value).replace("\t", " ").replace("\n", " ")


def write_review_tsv(path, results, duration, window_s):
    model_names = [name for name in MODEL_PAYLOADS if name in results]
    headers = ["start", "end", *model_names]
    lines = ["\t".join(headers)]
    start = 0
    while start < duration:
        end = min(duration, start + window_s)
        row = [format_srt_time(start), format_srt_time(end)]
        for name in model_names:
            row.append(segments_in_window(
                results[name].get("segments", []),
                start,
                end,
                include_emotion=name == "sensevoice",
            ))
        lines.append("\t".join(row))
        start = end
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def poll_gpu_peak(pid, stop_event, output):
    peak = 0
    while not stop_event.is_set():
        try:
            completed = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-compute-apps=pid,used_gpu_memory",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
                check=False,
            )
            for line in completed.stdout.splitlines():
                parts = [part.strip() for part in line.split(",")]
                if len(parts) == 2 and parts[0] == str(pid) and parts[1].isdigit():
                    peak = max(peak, int(parts[1]))
        except (OSError, subprocess.SubprocessError):
            pass
        stop_event.wait(0.25)
    output.append(peak or None)


def run_model(name, base_payload, script_path, output_dir, timeout_s):
    payload = {**base_payload}
    payload_path = output_dir / f"{name}.payload.json"
    result_path = output_dir / f"{name}.result.json"
    log_path = output_dir / f"{name}.log.txt"
    payload_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    environment = os.environ.copy()
    environment["PYTHONUTF8"] = "1"
    started = time.perf_counter()
    with result_path.open("w", encoding="utf-8") as stdout_file, log_path.open(
        "w", encoding="utf-8"
    ) as stderr_file:
        process = subprocess.Popen(
            [sys.executable, str(script_path)],
            cwd=str(script_path.parents[3]),
            env=environment,
            stdin=subprocess.PIPE,
            stdout=stdout_file,
            stderr=stderr_file,
            text=True,
            encoding="utf-8",
        )
        stop_event = threading.Event()
        peak_values = []
        poller = threading.Thread(
            target=poll_gpu_peak,
            args=(process.pid, stop_event, peak_values),
            daemon=True,
        )
        poller.start()
        try:
            process.communicate(
                json.dumps(payload, ensure_ascii=False),
                timeout=timeout_s,
            )
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise RuntimeError(f"{name} timed out after {timeout_s}s")
        finally:
            stop_event.set()
            poller.join(timeout=6)
    wall_time_s = time.perf_counter() - started
    if process.returncode:
        raise RuntimeError(
            f"{name} failed with exit code {process.returncode}; see {log_path}"
        )

    result = json.loads(result_path.read_text(encoding="utf-8"))
    result_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return result, wall_time_s, peak_values[0] if peak_values else None


def main():
    args = parse_args()
    project_root = Path(__file__).resolve().parents[1]
    input_path = args.input.resolve()
    output_dir = args.output_dir.resolve()
    script_path = project_root / "src" / "scripts" / "python" / "sensevoice_transcribe.py"
    if not input_path.is_file():
        raise SystemExit(f"input not found: {input_path}")
    output_dir.mkdir(parents=True, exist_ok=True)
    duration = audio_duration_s(input_path)

    results = {}
    summaries = {}
    for name in args.models:
        print(f"[benchmark] starting {name}", flush=True)
        payload = {
            **MODEL_PAYLOADS[name],
            "audio_path": str(input_path),
            "device": args.device,
            "enable_speaker": False,
            "include_raw": False,
            "gpu_throttle": {"enabled": False},
        }
        try:
            result, wall_time_s, peak_gpu_memory_mb = run_model(
                name,
                payload,
                script_path,
                output_dir,
                args.timeout_s,
            )
            segments = result.get("segments", [])
            results[name] = result
            text = "".join(str(segment.get("text", "")) for segment in segments)
            emotion_counts = Counter(
                segment["emotion"]
                for segment in segments
                if segment.get("emotion")
            )
            summaries[name] = {
                "status": "ok",
                "model": payload["model"],
                "wall_time_s": round(wall_time_s, 3),
                "audio_duration_s": round(duration, 3),
                "rtf": round(wall_time_s / duration, 5),
                "speed_x": round(duration / wall_time_s, 3),
                "peak_gpu_memory_mb": peak_gpu_memory_mb,
                "segment_count": len(segments),
                "character_count": len(normalized_characters(text)),
                "emotion_counts": dict(sorted(emotion_counts.items())),
                "timings": result.get("timings", {}),
            }
            write_srt(output_dir / f"{name}.srt", segments)
            if name == "sensevoice":
                emotion_segments = [
                    segment for segment in segments if segment.get("emotion") or segment.get("events")
                ]
                (output_dir / "sensevoice.emotions.json").write_text(
                    json.dumps(emotion_segments, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
        except Exception as exc:
            summaries[name] = {"status": "failed", "error": str(exc)}
        print(f"[benchmark] finished {name}: {summaries[name]['status']}", flush=True)

    successful_names = [name for name in args.models if name in results]
    pairwise_similarity = {}
    for index, left_name in enumerate(successful_names):
        left_text = "".join(
            str(segment.get("text", "")) for segment in results[left_name].get("segments", [])
        )
        for right_name in successful_names[index + 1:]:
            right_text = "".join(
                str(segment.get("text", ""))
                for segment in results[right_name].get("segments", [])
            )
            pairwise_similarity[f"{left_name}__{right_name}"] = round(
                character_similarity(left_text, right_text),
                4,
            )

    summary = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "input": str(input_path),
        "funasr_version": importlib.metadata.version("funasr"),
        "python_version": sys.version.split()[0],
        "device": args.device,
        "models": summaries,
        "pairwise_character_similarity": pairwise_similarity,
        "accuracy_note": (
            "Pairwise character similarity measures model agreement, not accuracy. "
            "Use review.tsv with the source audio for manual evaluation."
        ),
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if results:
        write_review_tsv(output_dir / "review.tsv", results, duration, args.window_s)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
