import contextlib
import json
import os
import sys

from sensevoice_pipeline import transcribe_segmented_backend, transcribe_with_vllm_pipeline
from sensevoice_paraformer import configure_paraformer_devices, transcribe_paraformer_builtin
from sensevoice_runtime import GpuThrottle, StageTimeout, coerce_bool, log_progress, suppress_model_output
from sensevoice_text import (
    _apply_hotword_correction,
    normalize_backend_name,
    normalize_segments,
    resolve_cached_model_name,
)

__all__ = [
    "GpuThrottle",
    "StageTimeout",
    "coerce_bool",
    "log_progress",
    "suppress_model_output",
    "normalize_backend_name",
    "normalize_segments",
    "resolve_cached_model_name",
    "configure_paraformer_devices",
    "transcribe_paraformer_builtin",
    "_apply_hotword_correction",
    "fail",
    "load_payload",
    "main",
]

# Compatibility facade: this file remains the stable stdin/stdout entrypoint for
# JS subprocess callers and re-exports helper symbols that sibling Python scripts
# import directly.


def fail(message, detail=None, code=1):
    payload = {"error": message}
    if detail:
        payload["detail"] = detail
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(code)


def load_payload():
    try:
        raw_bytes = sys.stdin.buffer.read()
        raw = raw_bytes.decode("utf-8-sig").lstrip("﻿")
        if not raw.strip():
            fail("ASR 输入为空，请通过 stdin 传入 JSON 配置")
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        fail("ASR 输入不是有效 JSON", str(exc))


def main():
    payload = load_payload()
    audio_path = payload.get("audio_path")
    if not audio_path or not os.path.exists(audio_path):
        fail("输入音频不存在", audio_path or "未提供 audio_path")
    log_progress(f"输入音频: {audio_path}")

    try:
        log_progress("导入 FunASR")
        from funasr import AutoModel
    except ImportError:
        fail(
            "funasr 未安装",
            "请先安装: pip install funasr modelscope torch torchaudio",
        )

    device = payload.get("device", "cuda")
    if device == "cuda":
        try:
            import torch

            if not torch.cuda.is_available():
                fail("CUDA 不可用", "配置 device=cuda，但 torch.cuda.is_available() 为 False")
        except ImportError:
            fail("CUDA 检查失败", "未安装 torch，无法使用 device=cuda")
    gpu_throttle = GpuThrottle(payload, device)
    if gpu_throttle.enabled:
        log_progress(
            "GPU 自适应节流已启用: "
            f"busy_sm_threshold={gpu_throttle.busy_sm_threshold:g}%, "
            f"busy_mem_threshold={gpu_throttle.busy_mem_threshold:g}%, "
            f"check_interval_s={gpu_throttle.check_interval_s:g}, "
            f"wait_s={gpu_throttle.wait_s:g}"
        )

    enable_speaker = bool(payload.get("enable_speaker", False))
    spk_model = payload.get("spk_model")
    if enable_speaker and not spk_model:
        fail("说话人分离已启用但 spk_model 未配置", "例如 spk_model=cam++")

    original_stdout = sys.stdout
    with contextlib.redirect_stdout(sys.stderr):
        backend_name = normalize_backend_name(payload.get("backend") or "sensevoice")
        if backend_name == "fun_asr_nano_vllm":
            raw_result = transcribe_with_vllm_pipeline(
                payload,
                audio_path,
                device,
                gpu_throttle,
                fail_fn=fail,
            )
            output = {
                "backend": backend_name,
                "language": payload.get("language", "中文"),
                "segments": normalize_segments(raw_result),
                "timings": payload.get("_timings", {}),
                "speaker_processing": payload.get("_speaker_processing"),
                "emotion_analysis": payload.get("_emotion_analysis"),
            }
            if payload.get("include_raw", False):
                output["raw"] = raw_result
            print(json.dumps(output, ensure_ascii=False, default=str), file=original_stdout)
            return

        paraformer_profile = str(payload.get("model_profile") or "").strip().lower()
        paraformer_model_value = str(payload.get("model") or "").strip()
        is_finetuned_paraformer = (
            backend_name == "paraformer"
            and (
                paraformer_profile == "finetuned"
                or bool(payload.get("finetuned_model"))
                or os.path.isdir(paraformer_model_value)
            )
        )
        use_segmented_paraformer = (
            gpu_throttle.enabled and gpu_throttle.segment_paraformer and not is_finetuned_paraformer
        )
        if backend_name == "paraformer" and not use_segmented_paraformer:
            raw_result = transcribe_paraformer_builtin(
                payload,
                audio_path,
                device,
                gpu_throttle,
                fail_fn=fail,
            )
            output = {
                "backend": backend_name,
                "language": payload.get("language", "auto"),
                "segments": raw_result,
                "timings": payload.get("_timings", {}),
                "speaker_processing": payload.get("_speaker_processing"),
                "emotion_analysis": payload.get("_emotion_analysis"),
            }
            hotword_config = payload.get("phoneme_correction")
            if hotword_config and isinstance(hotword_config, dict) and hotword_config.get("enabled"):
                _apply_hotword_correction(output, payload)
            if payload.get("include_raw", False):
                output["raw"] = raw_result
            print(json.dumps(output, ensure_ascii=False, default=str), file=original_stdout)
            return

        raw_result = transcribe_segmented_backend(
            payload,
            audio_path,
            device,
            backend_name,
            AutoModel,
            gpu_throttle,
            fail_fn=fail,
        )

    output = {
        "backend": backend_name,
        "language": payload.get("language", "auto"),
        "segments": normalize_segments(raw_result),
        "timings": payload.get("_timings", {}),
        "speaker_processing": payload.get("_speaker_processing"),
        "emotion_analysis": payload.get("_emotion_analysis"),
    }
    if payload.get("include_raw", False):
        output["raw"] = raw_result

    hotword_config = payload.get("phoneme_correction")
    if hotword_config and isinstance(hotword_config, dict) and hotword_config.get("enabled"):
        _apply_hotword_correction(output, payload)

    print(json.dumps(output, ensure_ascii=False, default=str), file=original_stdout)


if __name__ == "__main__":
    main()
