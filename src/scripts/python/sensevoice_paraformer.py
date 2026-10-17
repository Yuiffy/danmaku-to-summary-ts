import gc
import json
import os
import re
import time
import traceback
import unicodedata

from sensevoice_runtime import (
    CpuThrottle,
    ResourcePeakMonitor,
    StageTimeout,
    log_progress,
    set_timing,
    suppress_model_output,
)
from sensevoice_emotion import analyze_paraformer_emotions
from speaker_identity import attach_speaker_evidence
from sensevoice_speaker import (
    build_speaker_reference_centroids,
    dominant_speaker_for_interval,
    load_audio_16k_mono,
    run_adaptive_speaker_engine,
    smooth_speaker_timeline,
)
from sensevoice_text import (
    extract_sensevoice_metadata,
    normalize_segments,
    resolve_cached_model_name,
    restore_punctuation,
)


def _fail(fail_fn, message, detail=None):
    if callable(fail_fn):
        fail_fn(message, detail)
    if detail:
        raise RuntimeError(f"{message}: {detail}")
    raise RuntimeError(message)


from paraformer_segments import (
    has_timed_segments, _normalize_paraformer_spacing, _paraformer_text_units,
    paraformer_full_text_to_segments, select_paraformer_speaker_intervals,
    extract_vad_speaker_intervals, paraformer_timestamp_to_sentences,
    pick_batched_result, normalize_model_results_with_meta,
)
from paraformer_postprocess import postprocess_paraformer, postprocess_cached_paraformer


def install_paraformer_timing_probe(
    model,
    gpu_throttle=None,
    cpu_throttle=None,
    payload=None,
):
    model._danmaku_gpu_throttle = gpu_throttle
    model._danmaku_cpu_throttle = cpu_throttle
    if isinstance(payload, dict):
        model._danmaku_resource_payload = payload
    if getattr(model, "_danmaku_timing_probe_installed", False):
        return

    original_inference = model.inference

    def timed_inference(*args, **kwargs):
        target = kwargs.get("model") or model.model
        if target is getattr(model, "vad_model", None):
            stage = "vad_s"
            stage_label = "VAD (CPU)"
            throttle = getattr(model, "_danmaku_cpu_throttle", None)
            wait_key = "vad_cpu_wait_s"
        elif target is getattr(model, "punc_model", None):
            stage = "punc_s"
            stage_label = "标点恢复 (CUDA)"
            throttle = getattr(model, "_danmaku_gpu_throttle", None)
            wait_key = "punc_gpu_wait_s"
        elif target is getattr(model, "spk_model", None):
            stage = "builtin_speaker_embedding_s"
            stage_label = "说话人嵌入 (CUDA)"
            throttle = getattr(model, "_danmaku_gpu_throttle", None)
            wait_key = "speaker_gpu_wait_s"
        else:
            stage = "asr_inference_s"
            stage_label = "ASR batch (CUDA)"
            throttle = getattr(model, "_danmaku_gpu_throttle", None)
            wait_key = "asr_gpu_wait_s"

        if str(getattr(model, 'kwargs', {}).get('device', 'cuda')) == 'cpu':
            stage_label = stage_label.replace('(CUDA)', '(CPU)')
        counts = getattr(model, "_danmaku_stage_counts", None)
        if not isinstance(counts, dict):
            counts = {}
            model._danmaku_stage_counts = counts
        counts[stage] = counts.get(stage, 0) + 1
        stage_instance = f"{stage_label} #{counts[stage]}"
        waited = float(throttle.wait_if_busy(stage_instance) or 0.0) if throttle else 0.0
        collector = getattr(model, "_danmaku_timing_collector", None)
        if isinstance(collector, dict) and waited > 0:
            collector[wait_key] = collector.get(wait_key, 0.0) + waited
        log_progress(f"开始 {stage_instance}，资源等待={waited:.1f}s")
        started = time.perf_counter()
        try:
            with ResourcePeakMonitor(
                getattr(model, "_danmaku_resource_payload", None),
                stage_label,
                gpu_throttle=throttle if stage != "vad_s" else None,
            ):
                result = original_inference(*args, **kwargs)
                if stage == "vad_s":
                    model._danmaku_vad_intervals = (
                        extract_vad_speaker_intervals(result)
                    )
                return result
        finally:
            collector = getattr(model, "_danmaku_timing_collector", None)
            if isinstance(collector, dict):
                collector[stage] = collector.get(stage, 0.0) + (time.perf_counter() - started)

    model.inference = timed_inference
    model._danmaku_timing_probe_installed = True


def _canonical_paraformer_device(device):
    normalized = str(device or "").strip().lower()
    if normalized == "cuda":
        return "cuda:0"
    return normalized


def _module_device_names(module):
    if module is None:
        return []

    tensors = []
    parameters = getattr(module, "parameters", None)
    if callable(parameters):
        tensors.extend(list(parameters()))
    buffers = getattr(module, "buffers", None)
    if callable(buffers):
        tensors.extend(list(buffers()))

    return sorted({str(tensor.device) for tensor in tensors if getattr(tensor, "device", None) is not None})


def configure_paraformer_devices(model, main_device, vad_device):
    """Keep ASR/punctuation on main_device and VAD on vad_device."""
    main_device = _canonical_paraformer_device(main_device)
    vad_device = _canonical_paraformer_device(vad_device)
    vad_model = getattr(model, "vad_model", None)
    if vad_model is None:
        log_progress(f"设备检查: ASR={main_device}，未启用 VAD")
        return

    vad_kwargs = getattr(model, "vad_kwargs", None)
    model_kwargs = getattr(model, "kwargs", None)
    if not isinstance(vad_kwargs, dict):
        raise RuntimeError("FunASR VAD kwargs 不可用，无法稳定切换 VAD device")
    if not isinstance(model_kwargs, dict):
        raise RuntimeError("FunASR ASR kwargs 不可用，无法稳定设置 ASR device")
    if not hasattr(model, "_store_base_configs"):
        raise RuntimeError("当前 FunASR AutoModel 缺少 _store_base_configs，拒绝使用不稳定的设备迁移")

    vad_model.to(vad_device)
    vad_kwargs["device"] = vad_device
    model_kwargs["device"] = main_device
    model._store_base_configs()

    expected_main = {main_device}
    expected_vad = {vad_device}
    module_devices = {
        "ASR": set(_module_device_names(getattr(model, "model", None))),
        "VAD": set(_module_device_names(vad_model)),
        "PUNC": set(_module_device_names(getattr(model, "punc_model", None))),
        "SPK": set(_module_device_names(getattr(model, "spk_model", None))),
    }
    if module_devices["ASR"] and module_devices["ASR"] != expected_main:
        raise RuntimeError(f"ASR 模型设备异常: 实际={sorted(module_devices['ASR'])}，期望={main_device}")
    if module_devices["VAD"] and module_devices["VAD"] != expected_vad:
        raise RuntimeError(f"VAD 模型设备异常: 实际={sorted(module_devices['VAD'])}，期望={vad_device}")
    for name in ("PUNC", "SPK"):
        if module_devices[name] and module_devices[name] != expected_main:
            raise RuntimeError(f"{name} 模型设备异常: 实际={sorted(module_devices[name])}，期望={main_device}")

    baseline_vad_kwargs = getattr(model, "_base_kwargs_map", {}).get("vad_kwargs", {})
    log_progress(
        "设备检查: "
        f"ASR module={sorted(module_devices['ASR']) or ['unknown']}, "
        f"ASR kwargs={model_kwargs.get('device')}, "
        f"VAD module={sorted(module_devices['VAD']) or ['unknown']}, "
        f"VAD kwargs={vad_kwargs.get('device')}, "
        f"VAD baseline={baseline_vad_kwargs.get('device') if isinstance(baseline_vad_kwargs, dict) else 'unknown'}, "
        f"PUNC module={sorted(module_devices['PUNC']) or ['none']}, "
        f"SPK module={sorted(module_devices['SPK']) or ['none']}"
    )


def transcribe_paraformer_builtin(payload, audio_path, device, gpu_throttle=None, runtime_cache=None, fail_fn=None):
    """Use FunASR's built-in pipeline for paraformer."""
    from funasr import AutoModel

    backend_started = time.perf_counter()
    payload["_timings"] = {'cpu_fallback': 1} if payload.get('_cpu_fallback') else {}
    payload["_resource_peaks"] = {}
    cpu_throttle = CpuThrottle(payload)
    from live_asr_cache import finish_cached_transcript
    cached_results = finish_cached_transcript(payload, audio_path)
    if cached_results is not None:
        return postprocess_cached_paraformer(payload, audio_path, device, cached_results,
            runtime_cache if isinstance(runtime_cache, dict) else {}, gpu_throttle, backend_started)

    device_name = "cuda:0" if device == "cuda" else device
    model_name = payload.get("model", "paraformer-zh")
    resolved_model = resolve_cached_model_name(model_name)
    log_progress(f"准备 paraformer 内建 pipeline: {resolved_model}")

    model_kwargs = {
        "model": resolved_model,
        "device": device_name,
        "disable_update": True,
        "ncpu": int(payload.get('ncpu') or 2) if device_name == 'cpu' else 4,
    }

    vad_model = payload.get("vad_model", "fsmn-vad")
    if vad_model:
        resolved_vad = resolve_cached_model_name(vad_model)
        model_kwargs["vad_model"] = resolved_vad
        vad_kwargs = dict(payload.get("vad_kwargs") or {})
        vad_kwargs.setdefault(
            "max_single_segment_time",
            int(payload.get("vad_max_single_segment_time_ms", 60000) or 60000),
        )
        vad_kwargs.setdefault(
            "chunk_size",
            int(payload.get("vad_chunk_size_ms", 60000) or 60000),
        )
        model_kwargs["vad_kwargs"] = vad_kwargs
        log_progress(f"  VAD: {resolved_vad}")

    punc_model = payload.get("punc_model", "ct-punc")
    if punc_model:
        resolved_punc = resolve_cached_model_name(punc_model)
        model_kwargs["punc_model"] = resolved_punc
        log_progress(f"  Punc: {resolved_punc}")

    spk_model = payload.get("spk_model")
    enable_speaker = bool(payload.get("enable_speaker", False))
    if enable_speaker and spk_model:
        log_progress(f"  SPK: {resolve_cached_model_name(spk_model)} (ASR 后自适应)")

    speaker_references = payload.get("speaker_references")
    if speaker_references and enable_speaker:
        log_progress(f"  Speaker references: {len(speaker_references)} speakers")

    vad_device = _canonical_paraformer_device(payload.get("vad_device") or device_name)
    cache_key = json.dumps(
        {
            "model_kwargs": model_kwargs,
            "vad_device": vad_device or None,
            "speaker_model": resolve_cached_model_name(spk_model) if enable_speaker and spk_model else None,
        },
        ensure_ascii=False,
        sort_keys=True,
        default=str,
    )
    cache = runtime_cache if isinstance(runtime_cache, dict) else {}
    cache_entry = cache.get("paraformer")
    cache_hit = bool(cache_entry and cache_entry.get("key") == cache_key)
    set_timing(payload, "model_cache_hit", 1 if cache_hit else 0)

    # Sample before model construction and before choosing the request batch.
    # This matters when the persistent worker receives its first request while
    # a game is already using the GPU.
    if gpu_throttle:
        gpu_throttle.wait_if_busy("paraformer pipeline 使用")
        if not cache_hit:
            wait_for_gap = getattr(gpu_throttle, "wait_for_model_load_gap", None)
            if callable(wait_for_gap):
                wait_for_gap("paraformer pipeline 加载")

    if cache_hit:
        model = cache_entry["model"]
        spk_model_obj = cache.get("speaker_model")
        reference_centroids = None
        log_progress("paraformer pipeline 命中常驻缓存，跳过 ASR 模型加载")
        set_timing(payload, "model_load_s", 0)
        set_timing(payload, "speaker_model_load_s", 0)
        set_timing(payload, "reference_embedding_s", 0)
    else:
        if cache_entry:
            log_progress("paraformer 模型配置变化，替换常驻缓存")
            cache.clear()
            cache_entry = None
            gc.collect()
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

        model_load_started = time.perf_counter()
        spk_model_obj = None
        try:
            if gpu_throttle:
                gpu_throttle.wait_if_busy("paraformer pipeline 加载")
            if enable_speaker and spk_model:
                spk_model_obj = cache.get("speaker_model")
                if spk_model_obj is None:
                    speaker_load_started = time.perf_counter()
                    with ResourcePeakMonitor(
                        payload,
                        "说话人模型加载 (CUDA)" if device == "cuda" else "说话人模型加载 (CPU)",
                        gpu_throttle=gpu_throttle if device == "cuda" else None,
                    ):
                        spk_model_obj = AutoModel(
                            model=resolve_cached_model_name(spk_model),
                            device=device_name,
                            ncpu=2 if device_name == 'cpu' else 4,
                            disable_update=True,
                        )
                    cache["speaker_model"] = spk_model_obj
                    set_timing(payload, "speaker_model_load_s", time.perf_counter() - speaker_load_started)
                else:
                    set_timing(payload, "speaker_model_load_s", 0)
            with ResourcePeakMonitor(
                payload,
                "paraformer pipeline 模型加载",
                gpu_throttle=gpu_throttle,
            ):
                with StageTimeout(payload.get("model_load_timeout_s", 180), "paraformer pipeline 加载"):
                    model = AutoModel(**model_kwargs)
            set_timing(payload, "model_load_s", time.perf_counter() - model_load_started)
            log_progress(f"paraformer pipeline 加载完成: {payload['_timings']['model_load_s']:.3f}s")
        except Exception as exc:
            _fail(fail_fn, "paraformer pipeline 加载失败", f"{exc}\n{traceback.format_exc()}")

        reference_centroids = None
        set_timing(payload, "reference_embedding_s", 0)
        cache["paraformer"] = {
            "key": cache_key,
            "model": model,
        }

    if enable_speaker and spk_model and spk_model_obj is None:
        try:
            speaker_load_started = time.perf_counter()
            with ResourcePeakMonitor(
                payload,
                "说话人模型加载 (CUDA)" if device == "cuda" else "说话人模型加载 (CPU)",
                gpu_throttle=gpu_throttle if device == "cuda" else None,
            ):
                spk_model_obj = AutoModel(
                    model=resolve_cached_model_name(spk_model),
                    device=device_name,
                    ncpu=2 if device_name == 'cpu' else 4,
                    disable_update=True,
                )
            cache["speaker_model"] = spk_model_obj
            set_timing(payload, "speaker_model_load_s", time.perf_counter() - speaker_load_started)
        except Exception as exc:
            log_progress(f"说话人模型加载失败，保留 ASR 结果: {exc}")
    else:
        set_timing(payload, "speaker_model_load_s", payload.get("_timings", {}).get("speaker_model_load_s", 0))

    try:
        configure_paraformer_devices(model, main_device=device_name, vad_device=vad_device)
        install_paraformer_timing_probe(
            model,
            gpu_throttle=gpu_throttle,
            cpu_throttle=cpu_throttle,
            payload=payload,
        )
    except Exception as exc:
        _fail(fail_fn, "paraformer pipeline 设备配置失败", f"{exc}\n{traceback.format_exc()}")

    inference_timings = {}
    model._danmaku_timing_collector = inference_timings
    model._danmaku_vad_intervals = []

    try:
        configured_batch_size_s = float(payload.get("batch_size_s", 300) or 300)
        interactive_batch_size_s = float(payload.get("interactive_batch_size_s", 0) or 0)
        batch_size_s = configured_batch_size_s
        if gpu_throttle and gpu_throttle.enabled and interactive_batch_size_s > 0:
            batch_size_s = min(batch_size_s, interactive_batch_size_s)
        generate_kwargs = {
            "input": audio_path,
            "batch_size_s": int(batch_size_s),
        }
        if punc_model:
            generate_kwargs["sentence_timestamp"] = True
        batch_size_threshold_s = payload.get("batch_size_threshold_s")
        if batch_size_threshold_s is not None:
            generate_kwargs["batch_size_threshold_s"] = int(float(batch_size_threshold_s))
        hotword = str(payload.get("hotword") or payload.get("hotword_unweighted") or "").strip()
        if hotword:
            generate_kwargs["hotword"] = hotword
        log_progress(
            f"开始转写 (batch_size_s={batch_size_s}, "
            f"configured_batch_size_s={configured_batch_size_s}, "
            f"batch_size_threshold_s={generate_kwargs.get('batch_size_threshold_s', 'default')}, "
            f"hotword={'yes' if hotword else 'no'})"
        )
        model._danmaku_stage_counts = {}
        pipeline_started = time.perf_counter()
        with StageTimeout(payload.get("process_timeout_s", 1800), "paraformer 转写"):
            with suppress_model_output():
                results = model.generate(**generate_kwargs)
        pipeline_elapsed = time.perf_counter() - pipeline_started
        set_timing(payload, "pipeline_total_s", pipeline_elapsed)
        for timing_key, timing_value in inference_timings.items():
            set_timing(payload, timing_key, timing_value)
        resource_wait_s = sum(
            value for key, value in inference_timings.items() if key.endswith("_wait_s")
        )
        set_timing(payload, "resource_wait_s", resource_wait_s)
        measured_pipeline = sum(inference_timings.values())
        set_timing(payload, "pipeline_overhead_s", max(0.0, pipeline_elapsed - measured_pipeline))
        model._danmaku_timing_collector = None
        overhead_s = max(0.0, pipeline_elapsed - measured_pipeline)
        log_progress(
            "paraformer 转写完成: "
            f"pipeline={pipeline_elapsed:.3f}s, "
            f"vad={inference_timings.get('vad_s', 0.0):.3f}s, "
            f"asr={inference_timings.get('asr_inference_s', 0.0):.3f}s, "
            f"asr_batches={model._danmaku_stage_counts.get('asr_inference_s', 0)}, "
            f"punc={inference_timings.get('punc_s', 0.0):.3f}s, "
            f"spk={inference_timings.get('builtin_speaker_embedding_s', 0.0):.3f}s, "
            f"resource_wait={resource_wait_s:.3f}s, "
            f"overhead(decode+merge+prep)={overhead_s:.3f}s"
        )
    except Exception as exc:
        model._danmaku_timing_collector = None
        _fail(fail_fn, "paraformer 转写失败", f"{exc}\n{traceback.format_exc()}")

    return postprocess_paraformer(payload, audio_path, device, results, model, spk_model_obj,
        cache, gpu_throttle, backend_started, enable_speaker, speaker_references, fail_fn)
