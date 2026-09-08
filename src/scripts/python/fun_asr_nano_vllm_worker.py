import contextlib
import json
import os
import sys
import time
import traceback

from sensevoice_transcribe import (
    GpuThrottle,
    StageTimeout,
    log_progress,
    normalize_segments,
    resolve_cached_model_name,
    suppress_model_output,
)
from sensevoice_runtime import set_timing
from speaker_identity import attach_speaker_evidence
from sensevoice_speaker import (
    build_speaker_reference_centroids,
    dominant_speaker_for_interval,
    load_audio_16k_mono,
    run_adaptive_speaker_engine,
)


def write_message(payload):
    print(json.dumps(payload, ensure_ascii=False, default=str), flush=True)


def read_messages():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError as exc:
            write_message({"type": "error", "error": "invalid_json", "detail": str(exc)})


def build_pipeline(config):
    device = config.get("device", "cuda")
    if device == "cuda":
        try:
            import torch
            if not torch.cuda.is_available():
                raise RuntimeError("配置 device=cuda，但 torch.cuda.is_available() 为 False")
        except ImportError as exc:
            raise RuntimeError("未安装 torch，无法使用 fun_asr_nano_vllm") from exc

    try:
        import vllm  # noqa: F401
    except ImportError as exc:
        raise RuntimeError(
            "vLLM 未安装，无法使用 fun_asr_nano_vllm；请安装 vLLM 及匹配 CUDA/PyTorch 依赖，"
            "或临时改用 fun_asr_nano / sensevoice。"
        ) from exc
    try:
        from funasr.models.fun_asr_nano.inference_vllm_pipeline import FunASRNanoVLLMPipeline
    except ImportError as exc:
        raise RuntimeError("当前 FunASR 包缺少 Fun-ASR-Nano vLLM pipeline，请升级 funasr。") from exc
    resolved_model = resolve_cached_model_name(config.get("model", "FunAudioLLM/Fun-ASR-Nano-2512"))
    resolved_vad_model = resolve_cached_model_name(config.get("vad_model", "fsmn-vad")) if config.get("vad_model") else None
    resolved_spk_model = None
    device_name = "cuda:0" if device == "cuda" else device
    gpu_throttle = GpuThrottle(config, device)
    if gpu_throttle.enabled:
        log_progress(
            "GPU 自适应节流已启用: "
            f"busy_sm_threshold={gpu_throttle.busy_sm_threshold:g}%, "
            f"busy_mem_threshold={gpu_throttle.busy_mem_threshold:g}%, "
            f"check_interval_s={gpu_throttle.check_interval_s:g}, "
            f"wait_s={gpu_throttle.wait_s:g}"
        )

    spk_kwargs = None
    if resolved_spk_model:
        spk_kwargs = {
            "cb_kwargs": {
                "merge_thr": float(config.get("speaker_merge_threshold", 0.78))
            }
        }

    gpu_throttle.wait_if_busy("Fun-ASR-Nano vLLM worker 加载")
    with StageTimeout(config.get("model_load_timeout_s", 600), "Fun-ASR-Nano vLLM worker 加载"):
        model = FunASRNanoVLLMPipeline(
            model=resolved_model,
            vad_model=resolved_vad_model,
            vad_kwargs=config.get("vad_kwargs") or None,
            spk_model=resolved_spk_model,
            spk_kwargs=spk_kwargs,
            hub=config.get("hub", "ms"),
            device=device_name,
            dtype=config.get("dtype", "bf16"),
            tensor_parallel_size=int(config.get("tensor_parallel_size", 1) or 1),
            gpu_memory_utilization=float(config.get("gpu_memory_utilization", 0.8) or 0.8),
            max_model_len=int(config.get("max_model_len", 4096) or 4096),
            enforce_eager=bool(config.get("enforce_eager", False)),
        )
    return model, gpu_throttle


def build_speaker_model(config):
    if not config.get("enable_speaker"):
        return None
    from funasr import AutoModel

    device = config.get("device", "cuda")
    return AutoModel(
        model=resolve_cached_model_name(config.get("spk_model")),
        device="cuda:0" if device == "cuda" else device,
        disable_update=True,
    )


def transcribe(model, config, job, gpu_throttle=None, spk_model_obj=None):
    audio_path = job.get("audio_path")
    if not audio_path or not os.path.exists(audio_path):
        raise FileNotFoundError(f"输入音频不存在: {audio_path or '未提供 audio_path'}")

    if gpu_throttle:
        gpu_throttle.wait_if_busy("Fun-ASR-Nano vLLM worker 转写")
    with StageTimeout(job.get("asr_timeout_s", config.get("process_timeout_s", 3600)), "Fun-ASR-Nano vLLM worker 转写"):
        with suppress_model_output():
            results = model.generate(
                audio_path,
                hotwords=job.get("hotwords") if isinstance(job.get("hotwords"), list) else [],
                language=job.get("language", config.get("language", "中文")),
                itn=bool(job.get("use_itn", config.get("use_itn", True))),
                max_new_tokens=int(job.get("max_new_tokens", config.get("max_new_tokens", 512)) or 512),
                batch_size_s=int(float(job.get("batch_size_s", config.get("batch_size_s", 300)) or 300)),
                return_spk_res=False,
                preset_spk_num=None,
            )

    normalized = normalize_segments(results)
    payload = {**config, **job, "_timings": {}}
    enable_speaker = bool(payload.get("enable_speaker", False))
    if enable_speaker:
        try:
            device = payload.get("device", config.get("device", "cuda"))
            if spk_model_obj is None:
                model_started = time.perf_counter()
                spk_model_obj = build_speaker_model(payload)
                set_timing(payload, "speaker_model_load_s", time.perf_counter() - model_started)
            else:
                set_timing(payload, "speaker_model_load_s", 0)
            audio, sample_rate = load_audio_16k_mono(audio_path)
            intervals = [
                {"start": item.get("start", 0), "end": item.get("end", 0)}
                for item in normalized
                if float(item.get("end", 0) or 0) > float(item.get("start", 0) or 0)
            ]
            def load_references():
                return build_speaker_reference_centroids(
                    spk_model_obj,
                    payload.get("speaker_references"),
                    device,
                    batch_size=int(payload.get("speaker_embedding_batch_size", 64) or 64),
                    prototype_merge_threshold=float(
                        payload.get(
                            "speaker_reference_prototype_merge_threshold",
                            0.72,
                        )
                        or 0.72
                    ),
                    max_prototypes=int(
                        payload.get(
                            "speaker_reference_max_prototypes",
                            6,
                        )
                        or 6
                    ),
                    prototype_min_support_chunks=int(
                        payload.get(
                            "speaker_reference_prototype_min_support_chunks",
                            2,
                        )
                        or 2
                    ),
                )

            adaptive = run_adaptive_speaker_engine(
                spk_model_obj,
                audio,
                sample_rate,
                intervals,
                payload=payload,
                references=load_references if payload.get("speaker_references") else None,
            )
            for item in normalized:
                speaker, score = dominant_speaker_for_interval(
                    item.get("start", 0), item.get("end", 0), adaptive.get("timeline", [])
                )
                if speaker:
                    item["speaker"] = speaker
                if score:
                    item["speaker_score"] = score
                attach_speaker_evidence(item, adaptive.get("timeline", []), payload.get("speaker_identity_policy", "legacy"))
            payload["_speaker_processing"] = adaptive.get("processing", {})
            timing = payload["_speaker_processing"].get("timings", {})
            set_timing(payload, "speaker_probe_embedding_s", timing.get("probe_embedding_s", 0))
            set_timing(payload, "speaker_probe_clustering_s", timing.get("probe_clustering_s", 0))
            set_timing(payload, "speaker_full_embedding_s", timing.get("full_embedding_s", 0))
            set_timing(payload, "speaker_full_clustering_s", timing.get("full_clustering_s", 0))
            set_timing(payload, "speaker_matching_s", timing.get("reference_matching_s", 0))
            set_timing(payload, "speaker_total_s", timing.get("total_s", 0))
        except Exception as exc:
            payload["_speaker_processing"] = {
                "mode": str(payload.get("speaker_detection_mode") or "auto"),
                "status": "failed", "decision": "inconclusive",
                "reason": "speaker_processing_error", "full_run": False,
                "error": str(exc),
            }
    else:
        payload["_speaker_processing"] = {
            "mode": "disabled", "status": "disabled", "decision": "disabled",
            "reason": "speaker_disabled", "full_run": False,
        }

    return {
        "backend": "fun_asr_nano_vllm",
        "language": job.get("language", config.get("language", "中文")),
        "segments": normalized,
        "timings": payload.get("_timings", {}),
        "speaker_processing": payload.get("_speaker_processing"),
    }


def main():
    config = None
    model = None
    gpu_throttle = None
    spk_model_obj = None
    original_stdout = sys.stdout

    for message in read_messages():
        msg_type = message.get("type")
        msg_id = message.get("id")

        if msg_type == "shutdown":
            write_message({"type": "shutdown", "id": msg_id})
            return

        if msg_type == "init":
            try:
                config = message.get("config") or {}
                with contextlib.redirect_stdout(sys.stderr):
                    model, gpu_throttle = build_pipeline(config)
                    spk_model_obj = build_speaker_model(config)
                write_message({"type": "ready", "id": msg_id, "backend": "fun_asr_nano_vllm"})
            except SystemExit:
                raise
            except Exception as exc:
                write_message({
                    "type": "error",
                    "id": msg_id,
                    "error": "init_failed",
                    "detail": f"{exc}\n{traceback.format_exc()}",
                })
            continue

        if msg_type == "transcribe":
            if model is None or config is None:
                write_message({"type": "error", "id": msg_id, "error": "not_ready", "detail": "worker 尚未 init"})
                continue
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    result = transcribe(model, config, message, gpu_throttle, spk_model_obj)
                write_message({"type": "result", "id": msg_id, "result": result})
            except Exception as exc:
                write_message({
                    "type": "error",
                    "id": msg_id,
                    "error": "transcribe_failed",
                    "detail": f"{exc}\n{traceback.format_exc()}",
                })
            continue

        write_message({"type": "error", "id": msg_id, "error": "unknown_type", "detail": str(msg_type)})


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        print(json.dumps({
            "type": "fatal",
            "error": str(exc),
            "detail": traceback.format_exc(),
        }, ensure_ascii=False), file=sys.stdout, flush=True)
        raise
