#!/usr/bin/env python3
"""Benchmark FunASR FSMN-VAD settings and input-format preparation.

The default experiment is:

    A: CUDA, chunk_size=60000 ms
    B: CUDA, chunk_size=120000 ms
    C: CPU,  chunk_size=120000 ms

For case A, the script also compares VAD on the original input with VAD on
an FFmpeg-produced 16 kHz, mono, PCM WAV.  FunASR's tqdm progress bar is
intentionally left enabled: this script does not pass ``disable_pbar``.

The benchmark measures model loading separately from VAD inference.  It also
records segment count and speech duration so a faster configuration is not
accepted if it changes the VAD result unexpectedly.
"""

from __future__ import annotations

import argparse
import gc
import json
import subprocess
import sys
import time
import wave
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


@dataclass(frozen=True)
class VadCase:
    name: str
    device: str
    chunk_size_ms: int


DEFAULT_FORMAT_CASES = ("A",)


def log(message: str) -> None:
    print(f"[VAD-BENCH] {message}", flush=True)


def parse_case_names(value: str) -> tuple[str, ...]:
    value = (value or "").strip()
    if not value or value.lower() in {"none", "off", "false"}:
        return ()

    names = tuple(item.strip().upper() for item in value.split(",") if item.strip())
    invalid = sorted(set(names) - {"A", "B", "C"})
    if invalid:
        raise argparse.ArgumentTypeError(
            f"未知 case: {', '.join(invalid)}；只支持 A、B、C 或 none"
        )
    return tuple(dict.fromkeys(names))


def build_cases(args: argparse.Namespace) -> tuple[VadCase, ...]:
    return (
        VadCase("A", args.cuda_device, args.case_a_chunk_size),
        VadCase("B", args.cuda_device, args.case_b_chunk_size),
        VadCase("C", args.cpu_device, args.case_c_chunk_size),
    )


def require_input(path: Path) -> Path:
    path = path.expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"输入文件不存在: {path}")
    return path


def run_ffmpeg_to_pcm_wav(
    source_path: Path,
    output_path: Path,
    ffmpeg_path: str,
) -> float:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        str(source_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        str(output_path),
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"找不到 FFmpeg: {ffmpeg_path}；请用 --ffmpeg 指定 ffmpeg.exe"
        ) from exc

    elapsed = time.perf_counter() - started
    if completed.returncode != 0 or not output_path.is_file():
        detail = (completed.stderr or completed.stdout or "无 FFmpeg 输出").strip()
        raise RuntimeError(
            f"FFmpeg 格式化失败，exit_code={completed.returncode}: {detail[-2000:]}"
        )
    return elapsed


def read_wav_info(path: Path) -> dict[str, Any]:
    with wave.open(str(path), "rb") as wav:
        return {
            "sample_rate": wav.getframerate(),
            "channels": wav.getnchannels(),
            "sample_width_bytes": wav.getsampwidth(),
            "frames": wav.getnframes(),
            "duration_s": round(wav.getnframes() / max(wav.getframerate(), 1), 3),
        }


def extract_segments(result: Any) -> list[list[float]]:
    value: Any = []
    if isinstance(result, list) and result:
        first = result[0]
        if isinstance(first, dict):
            value = first.get("value", [])
    elif isinstance(result, dict):
        value = result.get("value", [])

    segments: list[list[float]] = []
    if not isinstance(value, list):
        return segments
    for segment in value:
        if not isinstance(segment, (list, tuple)) or len(segment) < 2:
            continue
        try:
            start_ms = float(segment[0])
            end_ms = float(segment[1])
        except (TypeError, ValueError):
            continue
        segments.append([round(start_ms, 3), round(end_ms, 3)])
    return segments


def segment_stats(segments: Iterable[list[float]]) -> dict[str, Any]:
    segments = list(segments)
    total_speech_ms = sum(max(0.0, end - start) for start, end in segments)
    return {
        "segment_count": len(segments),
        "total_speech_s": round(total_speech_ms / 1000.0, 3),
        "first_segment_ms": segments[0] if segments else None,
        "last_segment_ms": segments[-1] if segments else None,
    }


def resolve_cached_model_name(model_name: str) -> str:
    """Use an existing ModelScope cache directory when it is available.

    This avoids waiting on a stale ModelScope download lock during a local
    benchmark.  If the cache is absent, return the original alias and let
    FunASR/ModelScope resolve or download it normally.
    """
    model_path = Path(model_name).expanduser()
    if model_path.is_dir():
        return str(model_path.resolve())

    aliases = {
        "fsmn-vad": "speech_fsmn_vad_zh-cn-16k-common-pytorch",
    }
    cache_dir_name = aliases.get(model_name)
    if not cache_dir_name:
        return model_name

    cache_path = (
        Path.home()
        / ".cache"
        / "modelscope"
        / "hub"
        / "models"
        / "iic"
        / cache_dir_name
    )
    if (cache_path / "config.yaml").is_file() and (cache_path / "model.pt").is_file():
        return str(cache_path.resolve())
    return model_name


def load_vad_model(model_name: str, device: str, max_single_segment_ms: int):
    try:
        from funasr import AutoModel
    except ImportError as exc:
        raise RuntimeError(
            "funasr 未安装；请使用包含 FunASR 1.3.7 的 Python 环境运行"
        ) from exc

    # Do not pass disable_pbar here.  The benchmark is intentionally run with
    # FunASR's tqdm progress display enabled.
    return AutoModel(
        model=resolve_cached_model_name(model_name),
        device=device,
        disable_update=True,
        max_single_segment_time=max_single_segment_ms,
    )


def run_one_vad(
    model: Any,
    input_path: Path,
    case: VadCase,
    repeat_index: int,
    input_mode: str,
) -> dict[str, Any]:
    log(
        f"开始 VAD: case={case.name}, mode={input_mode}, repeat={repeat_index}, "
        f"device={case.device}, chunk_size={case.chunk_size_ms}ms, input={input_path.name}"
    )
    started = time.perf_counter()
    # Keep this call visible: FunASR prints its tqdm progress bar here.
    raw_result = model.generate(
        input=str(input_path),
        chunk_size=case.chunk_size_ms,
    )
    vad_elapsed_s = time.perf_counter() - started
    segments = extract_segments(raw_result)
    stats = segment_stats(segments)
    result = {
        "case": case.name,
        "device": case.device,
        "chunk_size_ms": case.chunk_size_ms,
        "input_mode": input_mode,
        "input_path": str(input_path),
        "repeat": repeat_index,
        "vad_s": round(vad_elapsed_s, 3),
        "segments": segments,
        **stats,
    }
    log(
        f"VAD 完成: case={case.name}, mode={input_mode}, repeat={repeat_index}, "
        f"vad={vad_elapsed_s:.3f}s, segments={stats['segment_count']}, "
        f"speech={stats['total_speech_s']:.3f}s"
    )
    return result


def median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return round(ordered[middle], 3)
    return round((ordered[middle - 1] + ordered[middle]) / 2.0, 3)


def summarize_runs(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for run in runs:
        grouped.setdefault((run["case"], run["input_mode"]), []).append(run)

    summaries: list[dict[str, Any]] = []
    for (case, input_mode), group in grouped.items():
        vad_values = [float(item["vad_s"]) for item in group]
        summaries.append(
            {
                "case": case,
                "input_mode": input_mode,
                "repeats": len(group),
                "vad_median_s": median(vad_values),
                "vad_min_s": round(min(vad_values), 3),
                "vad_max_s": round(max(vad_values), 3),
                "segment_counts": sorted({item["segment_count"] for item in group}),
                "speech_durations_s": sorted({item["total_speech_s"] for item in group}),
            }
        )
    return summaries


def print_summary(
    summaries: list[dict[str, Any]],
    format_elapsed_s: float | None,
    normalized_path: Path | None,
) -> None:
    print("\n=== FunASR VAD benchmark summary ===")
    print("case  mode        median_s  min_s  max_s  segment_count  speech_s")
    print("----  ----------  --------  -----  -----  -------------  --------")
    for item in summaries:
        counts = ",".join(str(value) for value in item["segment_counts"])
        speech = ",".join(str(value) for value in item["speech_durations_s"])
        print(
            f"{item['case']:<4}  {item['input_mode']:<10}  "
            f"{item['vad_median_s']:>8}  {item['vad_min_s']:>5}  "
            f"{item['vad_max_s']:>5}  {counts:>13}  {speech:>8}"
        )

    if normalized_path is not None:
        print("\n=== Format comparison ===")
        print(f"normalized_wav: {normalized_path}")
        print(f"format_s: {format_elapsed_s:.3f}" if format_elapsed_s is not None else "format_s: n/a")
        by_case = {
            item["case"]: item
            for item in summaries
            if item["input_mode"] in {"direct", "formatted"}
        }
        for case in sorted({item["case"] for item in summaries}):
            direct = next(
                (item for item in summaries if item["case"] == case and item["input_mode"] == "direct"),
                None,
            )
            formatted = next(
                (item for item in summaries if item["case"] == case and item["input_mode"] == "formatted"),
                None,
            )
            if not direct or not formatted:
                continue
            direct_s = direct["vad_median_s"]
            formatted_s = formatted["vad_median_s"]
            total_s = round((format_elapsed_s or 0.0) + formatted_s, 3)
            delta = round(formatted_s - direct_s, 3)
            print(
                f"case {case}: direct_vad={direct_s}s, formatted_vad={formatted_s}s, "
                f"formatted_total_once={total_s}s, delta_vad={delta}s"
            )
            print(
                f"  segments direct={direct['segment_counts']}, "
                f"formatted={formatted['segment_counts']}; "
                f"speech_s direct={direct['speech_durations_s']}, "
                f"formatted={formatted['speech_durations_s']}"
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="待测试的原始音频或视频")
    parser.add_argument("--model", default="fsmn-vad", help="FunASR VAD 模型，默认 fsmn-vad")
    parser.add_argument("--cuda-device", default="cuda:0")
    parser.add_argument("--cpu-device", default="cpu")
    parser.add_argument("--case-a-chunk-size", type=int, default=60000)
    parser.add_argument("--case-b-chunk-size", type=int, default=120000)
    parser.add_argument("--case-c-chunk-size", type=int, default=120000)
    parser.add_argument("--max-single-segment-ms", type=int, default=60000)
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument(
        "--format-cases",
        type=parse_case_names,
        default=DEFAULT_FORMAT_CASES,
        help="为哪些 case 做原始输入/规范 WAV 对照；默认 A；传 none 可关闭",
    )
    parser.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg 可执行文件路径")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="结果目录；默认 tmp/funasr-vad-benchmark-时间戳",
    )
    args = parser.parse_args()
    if args.repeats < 1:
        parser.error("--repeats 必须 >= 1")
    for name in (
        "case_a_chunk_size",
        "case_b_chunk_size",
        "case_c_chunk_size",
        "max_single_segment_ms",
    ):
        if getattr(args, name) < 1:
            parser.error(f"--{name.replace('_', '-')} 必须 > 0")
    return args


def main() -> int:
    args = parse_args()
    source_path = require_input(args.input)
    resolved_model_name = resolve_cached_model_name(args.model)
    cases = build_cases(args)
    selected_cases = tuple(case for case in cases if case.name in args.format_cases)

    if args.output_dir is None:
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        output_dir = Path("tmp") / f"funasr-vad-benchmark-{timestamp}"
    else:
        output_dir = args.output_dir
    output_dir = output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    normalized_path: Path | None = None
    format_elapsed_s: float | None = None
    if selected_cases:
        normalized_path = output_dir / "normalized-16k-mono.wav"
        log(f"开始格式化: {source_path} -> {normalized_path}")
        format_elapsed_s = run_ffmpeg_to_pcm_wav(
            source_path,
            normalized_path,
            args.ffmpeg,
        )
        wav_info = read_wav_info(normalized_path)
        log(
            f"格式化完成: elapsed={format_elapsed_s:.3f}s, "
            f"sample_rate={wav_info['sample_rate']}, channels={wav_info['channels']}, "
            f"duration={wav_info['duration_s']:.3f}s"
        )
        if wav_info["sample_rate"] != 16000 or wav_info["channels"] != 1:
            raise RuntimeError(f"格式化结果不是 16 kHz 单声道: {wav_info}")
    else:
        log("未启用格式化对照: --format-cases none")

    all_runs: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    log(f"输入: {source_path}")
    log(f"VAD 模型: {resolved_model_name}")
    log(f"重复次数: {args.repeats}; cases: {', '.join(case.name for case in cases)}")
    log("FunASR tqdm 进度条保持开启")

    for case in cases:
        model = None
        try:
            log(f"加载模型: case={case.name}, device={case.device}")
            load_started = time.perf_counter()
            model = load_vad_model(args.model, case.device, args.max_single_segment_ms)
            model_load_s = time.perf_counter() - load_started
            log(f"模型加载完成: case={case.name}, load={model_load_s:.3f}s")

            for repeat_index in range(1, args.repeats + 1):
                direct_result = run_one_vad(
                    model,
                    source_path,
                    case,
                    repeat_index,
                    "direct",
                )
                direct_result["model_load_s"] = round(model_load_s, 3)
                all_runs.append(direct_result)

                if normalized_path is not None and case.name in args.format_cases:
                    formatted_result = run_one_vad(
                        model,
                        normalized_path,
                        case,
                        repeat_index,
                        "formatted",
                    )
                    formatted_result["model_load_s"] = round(model_load_s, 3)
                    formatted_result["format_s"] = round(format_elapsed_s or 0.0, 3)
                    all_runs.append(formatted_result)
        except Exception as exc:
            log(f"case 失败: {case.name}: {exc}")
            failures.append({"case": case.name, "error": str(exc)})
        finally:
            del model
            gc.collect()
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

    summaries = summarize_runs(all_runs)
    print_summary(summaries, format_elapsed_s, normalized_path)

    output = {
        "input": str(source_path),
        "model": args.model,
        "resolved_model": resolved_model_name,
        "repeats": args.repeats,
        "cases": [asdict(case) for case in cases],
        "format_cases": list(args.format_cases),
        "normalized_wav": str(normalized_path) if normalized_path else None,
        "format_s": round(format_elapsed_s, 3) if format_elapsed_s is not None else None,
        "runs": all_runs,
        "summary": summaries,
        "failures": failures,
    }
    result_path = output_dir / "results.json"
    result_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"结果已写入: {result_path}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
