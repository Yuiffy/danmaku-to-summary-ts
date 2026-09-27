"""Run pinned MOSS transcription in bounded windows and retain overlapping turns."""

from __future__ import annotations

from dataclasses import asdict
from difflib import SequenceMatcher
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


def media_duration(path: str) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
        check=True, capture_output=True, text=True,
    )
    duration = float(result.stdout.strip())
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("MOSS input has no usable duration")
    return duration


def windows(duration: float, chunk_seconds: float, overlap_seconds: float):
    if chunk_seconds <= 0 or overlap_seconds < 0 or overlap_seconds >= chunk_seconds:
        raise ValueError("MOSS chunk/overlap configuration is invalid")
    start = 0.0
    while start < duration:
        end = min(duration, start + chunk_seconds)
        yield start, end
        if end >= duration:
            break
        start = end - overlap_seconds


def _clean_text(text: str) -> str:
    return re.sub(r"\W+", "", text, flags=re.UNICODE).lower()


def match_previous_speakers(previous, current, overlap_start: float, overlap_end: float):
    """Link only repeated utterances in the overlap; unmatched voices get new IDs."""
    scores = {}
    for old in previous:
        if old["end"] <= overlap_start or old["start"] >= overlap_end:
            continue
        for new in current:
            if new["end"] <= overlap_start or new["start"] >= overlap_end:
                continue
            shared = min(old["end"], new["end"], overlap_end) - max(old["start"], new["start"], overlap_start)
            if shared < 0.4:
                continue
            old_text, new_text = _clean_text(old["text"]), _clean_text(new["text"])
            if min(len(old_text), len(new_text)) < 3:
                continue
            similarity = SequenceMatcher(None, old_text, new_text).ratio()
            if similarity < 0.45:
                continue
            key = (new["speaker"], old["speaker"])
            scores[key] = scores.get(key, 0.0) + shared * similarity
    mapping = {}
    occupied = set()
    for (local, global_label), score in sorted(scores.items(), key=lambda item: item[1], reverse=True):
        if score >= 0.6 and local not in mapping and global_label not in occupied:
            mapping[local] = global_label
            occupied.add(global_label)
    return mapping


def combine_windows(results, duration: float):
    segments = []
    previous = []
    previous_end = 0.0
    next_speaker = 1
    for start, end, local_rows in results:
        rows = []
        for row in local_rows:
            left = max(start, start + float(row["start"]))
            right = min(end, start + float(row["end"]))
            label = str(row.get("speaker") or "").strip()
            content = str(row.get("text") or "").strip()
            if math.isfinite(left) and math.isfinite(right) and right > left and content:
                rows.append({"start": left, "end": right, "speaker": label, "text": content})
        rows.sort(key=lambda row: (row["start"], row["end"]))
        overlap_end = min(previous_end, end)
        mapping = match_previous_speakers(previous, rows, start, overlap_end)
        for row in rows:
            local = row["speaker"]
            if local and local not in mapping:
                mapping[local] = f"S{next_speaker:02d}"
                next_speaker += 1
            row["speaker"] = mapping.get(local, "UNKNOWN")
        midpoint = (start + overlap_end) / 2 if previous else start
        for row in segments:
            if row["end"] > midpoint:
                row["end"] = max(row["start"], midpoint)
        segments = [row for row in segments if row["end"] > row["start"]]
        segments.extend({**row, "start": max(row["start"], midpoint)} for row in rows if row["end"] > midpoint)
        previous, previous_end = rows, end
    return sorted(segments, key=lambda row: (row["start"], row["end"]))


def transcribe(payload):
    import torch
    from transformers import AutoModelForCausalLM, AutoProcessor
    from moss_transcribe_diarize import parse_transcript
    from moss_transcribe_diarize.inference_utils import build_transcription_messages, generate_transcription

    source = str(payload["audio_path"])
    duration = media_duration(source)
    chunk_seconds = float(payload.get("chunk_seconds", 300))
    overlap_seconds = float(payload.get("overlap_seconds", 20))
    spans = list(windows(duration, chunk_seconds, overlap_seconds))
    device = torch.device(str(payload.get("device") or "cuda:0"))
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("MOSS CUDA device unavailable")
    torch.set_num_threads(4)
    model_path = str(payload.get("model") or "OpenMOSS-Team/MOSS-Transcribe-Diarize")
    revision = str(payload.get("revision") or "e8681d68e7042738ffca8ac8212bc8fcb1131ab8")
    load_started = time.perf_counter()
    model = AutoModelForCausalLM.from_pretrained(
        model_path, revision=revision, trust_remote_code=True, dtype="auto", attn_implementation="sdpa",
    ).to(device=device, dtype=torch.bfloat16).eval()
    processor = AutoProcessor.from_pretrained(model_path, revision=revision, trust_remote_code=True)
    load_seconds = time.perf_counter() - load_started
    results = []
    generated_tokens = 0
    inference_seconds = 0.0
    with tempfile.TemporaryDirectory(prefix="moss-asr-") as work:
        for index, (start, end) in enumerate(spans):
            wav = str(Path(work) / f"window-{index:04d}.wav")
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(start), "-i", source,
                "-t", str(end - start), "-vn", "-ac", "1", "-ar", "16000", "-y", wav,
            ], check=True, capture_output=True)
            limit = max(2048, math.ceil((end - start) * 18))
            started = time.perf_counter()
            generated = generate_transcription(
                model, processor, build_transcription_messages(wav), max_new_tokens=limit,
                do_sample=False, device=device, dtype=torch.bfloat16,
            )
            inference_seconds += time.perf_counter() - started
            generated_tokens += int(generated["generated_tokens"])
            if int(generated["generated_tokens"]) >= limit:
                raise RuntimeError(f"MOSS output truncated in window {index}")
            rows = [asdict(row) for row in parse_transcript(generated["text"])]
            results.append((start, end, rows))
            print(f"[ASR] MOSS window {index + 1}/{len(spans)}: {len(rows)} turns", file=sys.stderr, flush=True)
            if device.type == "cuda":
                torch.cuda.empty_cache()
    segments = combine_windows(results, duration)
    if not segments:
        raise RuntimeError("MOSS produced no usable segments")
    return {
        "backend": "moss", "segments": segments,
        "timings": {"model_load_s": load_seconds, "asr_inference_s": inference_seconds,
                    "backend_total_s": load_seconds + inference_seconds, "generated_tokens": generated_tokens},
        "speaker_processing": {"mode": "moss", "status": "full_completed", "decision": "multiple" if len({row["speaker"] for row in segments}) > 1 else "single",
                               "reason": "joint_transcription_diarization", "full_run": True,
                               "detectedClusters": len({row["speaker"] for row in segments}), "windowCount": len(spans),
                               "windowStitching": "overlap_utterance_match"},
    }


if __name__ == "__main__":
    try:
        print(json.dumps(transcribe(json.load(sys.stdin)), ensure_ascii=False))
    except Exception as exc:
        print(f"MOSS backend failed: {exc}", file=sys.stderr)
        raise
