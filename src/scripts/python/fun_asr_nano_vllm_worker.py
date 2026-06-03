import contextlib
import json
import os
import sys
import traceback

from sensevoice_transcribe import (
    StageTimeout,
    normalize_segments,
    resolve_cached_model_name,
    suppress_model_output,
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
    resolved_spk_model = resolve_cached_model_name(config.get("spk_model")) if config.get("enable_speaker") else None
    device_name = "cuda:0" if device == "cuda" else device

    spk_kwargs = None
    if resolved_spk_model:
        spk_kwargs = {
            "cb_kwargs": {
                "merge_thr": float(config.get("speaker_merge_threshold", 0.78))
            }
        }

    with StageTimeout(config.get("model_load_timeout_s", 600), "Fun-ASR-Nano vLLM worker 加载"):
        return FunASRNanoVLLMPipeline(
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


def transcribe(model, config, job):
    audio_path = job.get("audio_path")
    if not audio_path or not os.path.exists(audio_path):
        raise FileNotFoundError(f"输入音频不存在: {audio_path or '未提供 audio_path'}")

    with StageTimeout(job.get("asr_timeout_s", config.get("process_timeout_s", 3600)), "Fun-ASR-Nano vLLM worker 转写"):
        with suppress_model_output():
            results = model.generate(
                audio_path,
                hotwords=job.get("hotwords") if isinstance(job.get("hotwords"), list) else [],
                language=job.get("language", config.get("language", "中文")),
                itn=bool(job.get("use_itn", config.get("use_itn", True))),
                max_new_tokens=int(job.get("max_new_tokens", config.get("max_new_tokens", 512)) or 512),
                batch_size_s=int(float(job.get("batch_size_s", config.get("batch_size_s", 300)) or 300)),
                return_spk_res=bool(job.get("enable_speaker", config.get("enable_speaker", False))),
                preset_spk_num=job.get("preset_spk_num", config.get("preset_spk_num")),
            )

    return {
        "backend": "fun_asr_nano_vllm",
        "language": job.get("language", config.get("language", "中文")),
        "segments": normalize_segments(results),
    }


def main():
    config = None
    model = None
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
                    model = build_pipeline(config)
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
                    result = transcribe(model, config, message)
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
