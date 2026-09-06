"""Compare production ASR paths without overwriting recording sidecars."""

from __future__ import annotations

import argparse
import contextlib
import copy
import gc
import hashlib
import importlib.metadata
import json
from pathlib import Path
import statistics
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
PYTHON_DIR = ROOT / "src/scripts/python"
sys.path.insert(0, str(PYTHON_DIR))

from benchmark_funasr_models import normalized_characters, levenshtein_distance, write_srt
import sensevoice_pipeline
from sensevoice_paraformer import normalize_model_results_with_meta, transcribe_paraformer_builtin
from sensevoice_speaker import load_audio_16k_mono
from sensevoice_text import generate_with_optional_hotword, resolve_cached_model_name


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--sensevoice-audio", required=True, type=Path)
    parser.add_argument("--paraformer-audio", required=True, type=Path)
    parser.add_argument("--reference-manifest", type=Path)
    parser.add_argument("--sensevoice-batch-size", type=int, default=8)
    args = parser.parse_args()
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if (output / "summary.json").exists():
        raise SystemExit("Choose a new output directory; existing results are not overwritten.")
    config = json.loads((ROOT / "config/production.json").read_text(encoding="utf-8"))["asr"]
    metadata = {
        "python": sys.version,
        "versions": {key: importlib.metadata.version(key) for key in ("funasr", "torch", "numpy")},
        "source_sha256": {
            name: hashlib.sha256((PYTHON_DIR / name).read_bytes()).hexdigest()
            for name in ("sensevoice_pipeline.py", "sensevoice_paraformer.py", "sensevoice_speaker.py")
        },
        "sensevoice_batch_size": args.sensevoice_batch_size,
    }
    save(output / "environment.json", metadata)
    import torch
    from funasr import AutoModel

    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    torch.manual_seed(20260906)
    print("Runtime loaded; source fingerprints saved.", flush=True)
    summaries = {}
    runtime_cache = {}
    for backend, audio_path, repeat_count in (
        ("sensevoice", args.sensevoice_audio, 2),
        ("paraformer", args.paraformer_audio, 4),
    ):
        base = copy.deepcopy(config[backend])
        base.update({
            "backend": backend, "audio_path": str(audio_path.resolve()), "device": "cuda",
            "resource_guard": {"enabled": False}, "resource_peak_monitor": {"enabled": False},
            "gpu_throttle": {"enabled": False}, "cpu_throttle": {"enabled": False},
            "speaker_detection_mode": "auto", "room_id": "25788785" if backend == "paraformer" else "26966466",
        })
        if backend == "sensevoice":
            base["inference_batch_size"] = args.sensevoice_batch_size
        save(output / f"{backend}.payload.json", base)
        runs = []
        for repeat in range(repeat_count):
            payload = copy.deepcopy(base)
            torch.cuda.reset_peak_memory_stats()
            torch.cuda.synchronize()
            started = time.perf_counter()
            with (output / f"{backend}.{repeat}.log").open("w", encoding="utf-8") as log:
                with contextlib.redirect_stderr(log), contextlib.redirect_stdout(log):
                    if backend == "paraformer":
                        segments = transcribe_paraformer_builtin(payload, payload["audio_path"], "cuda", runtime_cache=runtime_cache)
                    else:
                        segments = sensevoice_pipeline.transcribe_segmented_backend(
                            payload, payload["audio_path"], "cuda", backend, AutoModel,
                        )
            torch.cuda.synchronize()
            result = {
                "repeat": repeat, "wall_s": time.perf_counter() - started,
                "timings": payload["_timings"], "segments": segments,
                "speaker_processing": payload.get("_speaker_processing"),
                "emotion_analysis": payload.get("_emotion_analysis"),
                "allocated_peak_mb": torch.cuda.max_memory_allocated() / 2**20,
            }
            save(output / f"{backend}.{repeat}.json", result)
            runs.append(result)
            print(f"{backend} repeat={repeat} wall={result['wall_s']:.3f}s segments={len(segments)}", flush=True)
        write_srt(output / f"{backend}.srt", runs[-1]["segments"])
        summaries[backend] = {
            "wall_runs_s": [run["wall_s"] for run in runs],
            "median_s": statistics.median(run["wall_s"] for run in runs),
            "warm_median_s": statistics.median(run["wall_s"] for run in runs[1:]) if backend == "paraformer" else None,
            "timings": [run["timings"] for run in runs],
        }
        runtime_cache.clear()
        gc.collect()
        torch.cuda.empty_cache()
    if args.reference_manifest:
        rows = json.loads(args.reference_manifest.read_text(encoding="utf-8"))["rows"]
        payload = {"language": "auto", "use_itn": True, "batch_size_s": 300,
                   "inference_batch_size": args.sensevoice_batch_size,
                   "resource_peak_monitor": {"enabled": False}, "_timings": {}}
        with (output / "references.log").open("w", encoding="utf-8") as log:
            with contextlib.redirect_stderr(log), contextlib.redirect_stdout(log):
                model = AutoModel(model=resolve_cached_model_name("iic/SenseVoiceSmall"), device="cuda:0", disable_update=True)
                audios = [load_audio_16k_mono(row["source"])[0] for row in rows]
                metas = [{"start": i * 20, "end": i * 20 + len(audio) / 16000} for i, audio in enumerate(audios)]
                torch.cuda.synchronize()
                started = time.perf_counter()
                batch_helper = getattr(sensevoice_pipeline, "transcribe_sensevoice_batches", None)
                if batch_helper:
                    segments = batch_helper(model, payload, audios, metas, None, "cuda")
                else:
                    segments = []
                    for audio, meta in zip(audios, metas):
                        result = generate_with_optional_hotword(model, payload, "sensevoice", input=audio, language="auto", use_itn=True, batch_size_s=300)
                        segments.extend(normalize_model_results_with_meta(result, meta, None))
                torch.cuda.synchronize()
                elapsed = time.perf_counter() - started
        predictions = [[] for _ in rows]
        for segment in segments:
            index = int(float(segment["start"]) // 20)
            assert 0 <= index < len(rows) and float(segment["end"]) <= metas[index]["end"] + 0.05
            predictions[index].append(segment["text"])
        comparisons = []
        for row, parts in zip(rows, predictions):
            ref = normalized_characters(row["target"])
            hypothesis = "".join(parts)
            comparisons.append({"key": row["key"], "reference": row["target"], "hypothesis": hypothesis,
                                "ref_chars": len(ref), "edits": levenshtein_distance(ref, normalized_characters(hypothesis))})
        summary = {"rows": comparisons, "inference_s": elapsed, "timings": payload["_timings"],
                   "reference_cer": sum(r["edits"] for r in comparisons) / sum(r["ref_chars"] for r in comparisons)}
        save(output / "references.json", summary)
        summaries["references"] = {key: value for key, value in summary.items() if key != "rows"}
        print(f"references wall={elapsed:.3f}s CER={summary['reference_cer']:.5f}", flush=True)
    save(output / "summary.json", summaries)


if __name__ == "__main__":
    main()
