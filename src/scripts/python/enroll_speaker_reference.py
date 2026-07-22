#!/usr/bin/env python3
"""Build staged CAM++ speaker-reference WAVs from reviewed local solo clips.

This tool never overwrites a canonical reference.  Supply a JSON enrollment
manifest with reviewed clip ranges, then inspect the generated report before
promoting a candidate manually.
"""

import argparse
import hashlib
import json
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="JSON enrollment manifest")
    parser.add_argument("--output-dir", type=Path, required=True, help="Candidate output directory")
    parser.add_argument("--min-rms", type=float, default=0.003, help="Reject near-silent chunks below this RMS")
    parser.add_argument("--max-clipping-ratio", type=float, default=0.002, help="Reject clipped chunks above this ratio")
    parser.add_argument("--skip-embedding-check", action="store_true", help="Skip CAM++ validation when local model is unavailable")
    return parser.parse_args()


def run(command):
    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
    if completed.returncode:
        raise RuntimeError(completed.stderr.strip() or "command failed")


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_audio(path, min_rms, max_clipping_ratio):
    import soundfile as sf

    audio, sample_rate = sf.read(path, dtype="float32", always_2d=False)
    if getattr(audio, "ndim", 1) > 1:
        audio = audio.mean(axis=1)
    duration_s = len(audio) / sample_rate if sample_rate else 0
    rms = math.sqrt(float((audio * audio).mean())) if len(audio) else 0
    clipping_ratio = float((abs(audio) >= 0.999).mean()) if len(audio) else 1
    reasons = []
    if sample_rate != 16000:
        reasons.append(f"sample_rate={sample_rate}")
    if duration_s < 5.5:
        reasons.append(f"duration={duration_s:.2f}s")
    if rms < min_rms:
        reasons.append(f"rms={rms:.6f}")
    if clipping_ratio > max_clipping_ratio:
        reasons.append(f"clipping={clipping_ratio:.5f}")
    return {
        "durationSeconds": round(duration_s, 3),
        "rms": round(rms, 6),
        "clippingRatio": round(clipping_ratio, 6),
        "accepted": not reasons,
        "reasons": reasons,
    }


def validate_embeddings(paths):
    import torch
    from funasr import AutoModel
    import soundfile as sf

    model = AutoModel(
        model="iic/speech_campplus_sv_zh-cn_16k-common",
        device="cuda:0" if torch.cuda.is_available() else "cpu",
        disable_update=True,
    )
    report = {}
    for path in paths:
        audio, _ = sf.read(path, dtype="float32", always_2d=False)
        if getattr(audio, "ndim", 1) > 1:
            audio = audio.mean(axis=1)
        result = model.generate(input=[audio], cache={}, is_final=True)
        embedding = result[0].get("spk_embedding") if result else None
        valid = embedding is not None and torch.isfinite(embedding).all().item()
        report[path.name] = {"embeddingValid": bool(valid)}
    return report


def main():
    args = parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    speaker = str(manifest["speaker"])
    clips = manifest.get("clips", [])
    if not clips:
        raise ValueError("manifest.clips must not be empty")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    work_dir = Path(tempfile.mkdtemp(prefix="speaker_enroll_"))
    accepted_paths = []
    report = {
        "schemaVersion": 1,
        "speaker": speaker,
        "sourceManifest": str(args.manifest.resolve()),
        "processing": {
            "sampleRate": 16000,
            "channels": 1,
            "audioFilter": "highpass=f=80,lowpass=f=7600,loudnorm=I=-20:TP=-2:LRA=11",
        },
        "clips": [],
    }
    try:
        for index, clip in enumerate(clips, start=1):
            source = Path(clip["source"])
            if not source.exists():
                report["clips"].append({**clip, "accepted": False, "reasons": ["source_missing"]})
                continue
            start = float(clip["startSeconds"])
            duration = float(clip.get("durationSeconds", 8))
            output = work_dir / f"clip_{index:03d}.wav"
            run([
                "ffmpeg", "-y", "-ss", str(start), "-t", str(duration), "-i", str(source),
                "-vn", "-ac", "1", "-ar", "16000",
                "-af", report["processing"]["audioFilter"], "-f", "wav", str(output),
                "-nostdin", "-loglevel", "error",
            ])
            validation = validate_audio(output, args.min_rms, args.max_clipping_ratio)
            item = {**clip, **validation}
            report["clips"].append(item)
            if validation["accepted"]:
                accepted_paths.append(output)

        if not accepted_paths:
            raise RuntimeError("no candidate clips passed audio validation")
        if not args.skip_embedding_check:
            embedding_report = validate_embeddings(accepted_paths)
            accepted_by_name = {path.name: path for path in accepted_paths}
            for index, item in enumerate(report["clips"], start=1):
                clip_name = f"clip_{index:03d}.wav"
                if clip_name not in accepted_by_name:
                    continue
                item.update(embedding_report.get(clip_name, {}))
                if item.get("embeddingValid") is False:
                    item["accepted"] = False
                    item.setdefault("reasons", []).append("invalid_campp_embedding")
            accepted_paths = [
                accepted_by_name[f"clip_{index:03d}.wav"]
                for index, item in enumerate(report["clips"], start=1)
                if item.get("accepted") and f"clip_{index:03d}.wav" in accepted_by_name
            ]
        if not accepted_paths:
            raise RuntimeError("no candidate clips passed CAM++ validation")

        concat_list = work_dir / "concat.txt"
        concat_list.write_text("".join(f"file '{path.as_posix()}'\n" for path in accepted_paths), encoding="utf-8")
        output_name = f"{manifest.get('key', speaker)}_candidate.wav"
        candidate_path = args.output_dir / output_name
        run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list), "-c:a", "pcm_s16le", str(candidate_path), "-nostdin", "-loglevel", "error"])
        report["candidatePath"] = str(candidate_path.resolve())
        report["candidateSha256"] = sha256(candidate_path)
        report["acceptedClipCount"] = len(accepted_paths)
        report["candidateSeconds"] = round(sum(item["durationSeconds"] for item in report["clips"] if item.get("accepted")), 3)
        report_path = args.output_dir / f"{manifest.get('key', speaker)}_candidate_report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"candidate": str(candidate_path), "report": str(report_path)}, ensure_ascii=False))
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"enrollment failed: {error}", file=sys.stderr)
        sys.exit(1)
