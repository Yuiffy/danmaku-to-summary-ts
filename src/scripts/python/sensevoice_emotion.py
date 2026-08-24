import contextlib
import gc
import json
import time

from sensevoice_runtime import (
    ResourcePeakMonitor,
    StageTimeout,
    log_progress,
    suppress_model_output,
)
from sensevoice_speaker import load_audio_16k_mono
from sensevoice_text import extract_sensevoice_metadata, resolve_cached_model_name


def _coerce_bool(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _is_cuda_device(device):
    return str(device or "").strip().lower().startswith("cuda")


def _coerce_positive_int(value, default):
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return max(1, int(default))


def _load_torch_for_device(device):
    if not _is_cuda_device(device):
        return None
    try:
        import torch
    except ImportError:
        return None
    cuda = getattr(torch, "cuda", None)
    is_available = getattr(cuda, "is_available", None)
    if callable(is_available) and not is_available():
        return None
    return torch


def _resolve_precision(config, device, torch_module):
    requested = str(config.get("precision") or "bf16").strip().lower()
    if requested in {"bfloat16", "bf16", "amp-bf16", "mixed-bf16"}:
        if torch_module is not None and _is_cuda_device(device):
            return "bf16"
        return "fp32"
    return "fp32"


@contextlib.contextmanager
def _cuda_tf32_context(device, enabled, torch_module):
    """Enable TF32 only while SenseVoice emotion inference is running."""
    if not enabled or torch_module is None or not _is_cuda_device(device):
        yield False
        return

    previous = []
    backends = getattr(torch_module, "backends", None)
    cuda_backend = getattr(backends, "cuda", None)
    matmul_backend = getattr(cuda_backend, "matmul", None)
    cudnn_backend = getattr(backends, "cudnn", None)
    for backend, name in (
        (matmul_backend, "allow_tf32"),
        (cudnn_backend, "allow_tf32"),
    ):
        if backend is None or not hasattr(backend, name):
            continue
        previous.append((backend, name, getattr(backend, name)))
        setattr(backend, name, True)

    precision_getter = getattr(torch_module, "get_float32_matmul_precision", None)
    precision_setter = getattr(torch_module, "set_float32_matmul_precision", None)
    previous_precision = None
    if callable(precision_getter) and callable(precision_setter):
        try:
            previous_precision = precision_getter()
            precision_setter("high")
        except Exception:
            previous_precision = None

    try:
        yield bool(previous or previous_precision is not None)
    finally:
        for backend, name, value in previous:
            try:
                setattr(backend, name, value)
            except Exception:
                pass
        if previous_precision is not None:
            try:
                precision_setter(previous_precision)
            except Exception:
                pass


def _bf16_autocast(torch_module):
    autocast = getattr(torch_module, "autocast", None)
    if callable(autocast):
        return autocast(device_type="cuda", dtype=torch_module.bfloat16)
    cuda = getattr(torch_module, "cuda", None)
    amp = getattr(cuda, "amp", None)
    legacy_autocast = getattr(amp, "autocast", None)
    if callable(legacy_autocast):
        return legacy_autocast(dtype=torch_module.bfloat16)
    raise RuntimeError("当前 PyTorch 不支持 CUDA BF16 autocast")


def _generate_emotion_batch(
    model,
    audio_batch,
    config,
    effective_batch_size_s,
    precision,
    torch_module=None,
):
    kwargs = {
        "input": audio_batch,
        "language": config.get("language", "auto"),
        "use_itn": False,
        "batch_size": _coerce_positive_int(config.get("inference_batch_size"), 8),
        "batch_size_s": max(1, int(float(effective_batch_size_s))),
    }
    if precision != "bf16" or torch_module is None:
        return model.generate(**kwargs), False

    try:
        with _bf16_autocast(torch_module):
            return model.generate(**kwargs), False
    except Exception as exc:
        log_progress(f"SenseVoice BF16 情感推理失败，当前批次回退 FP32: {exc}")
        return model.generate(**kwargs), True


def merge_segments_to_emotion_chunks(segments, chunk_s=12.0, max_gap_s=1.5):
    chunk_s = max(1.0, float(chunk_s or 12.0))
    max_gap_s = max(0.0, float(max_gap_s or 0.0))
    valid = []
    for index, segment in enumerate(segments or []):
        try:
            start = float(segment.get("start"))
            end = float(segment.get("end"))
        except (TypeError, ValueError):
            continue
        if end <= start:
            continue
        valid.append({
            "start": start,
            "end": end,
            "text": str(segment.get("text") or "").strip(),
            "segment_indices": [index],
        })
    valid.sort(key=lambda item: (item["start"], item["end"]))

    chunks = []
    current = None
    for item in valid:
        if current is None:
            current = dict(item)
            continue
        gap = item["start"] - current["end"]
        merged_end = max(current["end"], item["end"])
        if gap <= max_gap_s and merged_end - current["start"] <= chunk_s:
            current["end"] = merged_end
            current["segment_indices"].extend(item["segment_indices"])
            if item["text"]:
                current["text"] = "".join(filter(None, [current["text"], item["text"]]))
            continue
        chunks.append(current)
        current = dict(item)
    if current is not None:
        chunks.append(current)

    for index, chunk in enumerate(chunks):
        chunk["index"] = index
        chunk["start"] = round(chunk["start"], 3)
        chunk["end"] = round(chunk["end"], 3)
    return chunks


def build_duration_batches(chunks, max_batch_duration_s=300.0, max_batch_chunks=64):
    max_batch_duration_s = max(1.0, float(max_batch_duration_s or 300.0))
    max_batch_chunks = max(1, int(max_batch_chunks or 64))
    batches = []
    current = []
    current_duration = 0.0
    for chunk in chunks or []:
        duration = max(0.0, float(chunk["end"]) - float(chunk["start"]))
        if current and (
            len(current) >= max_batch_chunks
            or current_duration + duration > max_batch_duration_s
        ):
            batches.append(current)
            current = []
            current_duration = 0.0
        current.append(chunk)
        current_duration += duration
    if current:
        batches.append(current)
    return batches


def _overlap_seconds(a_start, a_end, b_start, b_end):
    return max(0.0, min(float(a_end), float(b_end)) - max(float(a_start), float(b_start)))


def project_emotion_timeline_to_segments(segments, timeline):
    for segment in segments or []:
        try:
            start = float(segment["start"])
            end = float(segment["end"])
        except (KeyError, TypeError, ValueError):
            continue
        overlaps = [
            (item, _overlap_seconds(start, end, item["start"], item["end"]))
            for item in timeline or []
        ]
        overlaps = [(item, overlap) for item, overlap in overlaps if overlap > 0]
        if not overlaps:
            continue
        emotion_scores = {}
        for item, overlap in overlaps:
            emotion = item.get("emotion")
            if emotion:
                emotion_scores[emotion] = emotion_scores.get(emotion, 0.0) + overlap
        if emotion_scores:
            segment["emotion"] = max(emotion_scores.items(), key=lambda pair: pair[1])[0]
        events = []
        for item, _overlap in overlaps:
            for event in item.get("events") or []:
                if event not in events:
                    events.append(event)
        if events:
            segment["events"] = events
    return segments


def _load_emotion_model(config, device, runtime_cache, auto_model_cls):
    model_name = resolve_cached_model_name(config.get("model", "iic/SenseVoiceSmall"))
    device_name = "cuda:0" if device == "cuda" else device
    cache_key = json.dumps(
        {"model": model_name, "device": device_name},
        ensure_ascii=False,
        sort_keys=True,
    )
    cache = runtime_cache if isinstance(runtime_cache, dict) else {}
    entry = cache.get("emotion_model")
    if entry and entry.get("key") == cache_key:
        return entry["model"], True, model_name, 0.0

    if entry:
        cache.pop("emotion_model", None)
        gc.collect()
    started = time.perf_counter()
    model = auto_model_cls(
        model=model_name,
        device=device_name,
        disable_update=True,
    )
    elapsed = time.perf_counter() - started
    cache["emotion_model"] = {
        "key": cache_key,
        "model": model,
    }
    return model, False, model_name, elapsed


def _result_item(results, index):
    if isinstance(results, dict):
        return results if index == 0 else {}
    if not isinstance(results, list) or index >= len(results):
        return {}
    item = results[index]
    if isinstance(item, list):
        item = item[0] if item else {}
    return item if isinstance(item, dict) else {}


def analyze_paraformer_emotions(
    payload,
    audio_path,
    segments,
    device,
    runtime_cache=None,
    gpu_throttle=None,
    audio_data=None,
    sample_rate=None,
    auto_model_cls=None,
    audio_loader=load_audio_16k_mono,
):
    config = payload.get("emotion_analysis")
    if not isinstance(config, dict) or not _coerce_bool(config.get("enabled"), False):
        return None
    room_ids = {
        str(value).strip()
        for value in config.get("room_ids") or []
        if str(value).strip()
    }
    room_id = str(payload.get("room_id") or "").strip()
    if room_ids and room_id not in room_ids:
        return None

    started = time.perf_counter()
    fail_open = _coerce_bool(config.get("fail_open"), True)
    emotion_device = str(config.get("device") or device)
    analysis = {
        "status": "running",
        "model": str(config.get("model") or "iic/SenseVoiceSmall"),
        "chunks": 0,
        "labeledChunks": 0,
        "emotionCounts": {},
        "eventCounts": {},
        "timeline": [],
        "timings": {},
    }
    try:
        chunks = merge_segments_to_emotion_chunks(
            segments,
            chunk_s=config.get("chunk_s", 12),
            max_gap_s=config.get("max_gap_s", 1.5),
        )
        analysis["chunks"] = len(chunks)
        if not chunks:
            analysis["status"] = "completed"
            analysis["timings"]["total_s"] = time.perf_counter() - started
            payload["_emotion_analysis"] = analysis
            return analysis

        if audio_data is None or not sample_rate:
            audio_load_started = time.perf_counter()
            audio_data, sample_rate = audio_loader(audio_path)
            analysis["timings"]["audio_load_s"] = time.perf_counter() - audio_load_started
        else:
            analysis["timings"]["audio_load_s"] = 0.0

        if auto_model_cls is None:
            from funasr import AutoModel
            auto_model_cls = AutoModel

        if gpu_throttle:
            gpu_throttle.wait_if_busy("SenseVoice 情感模型加载")
        with ResourcePeakMonitor(
            payload,
            "SenseVoice 情感模型加载",
            gpu_throttle=gpu_throttle,
        ):
            with StageTimeout(config.get("model_load_timeout_s", 180), "SenseVoice 情感模型加载"):
                model, cache_hit, resolved_model, model_load_s = _load_emotion_model(
                    config,
                    emotion_device,
                    runtime_cache,
                    auto_model_cls,
                )
        analysis["resolvedModel"] = resolved_model
        analysis["modelCacheHit"] = cache_hit
        analysis["timings"]["model_load_s"] = model_load_s

        torch_module = _load_torch_for_device(emotion_device)
        inference_batch_size = _coerce_positive_int(
            config.get("inference_batch_size"), 8
        )
        precision_requested = str(config.get("precision") or "bf16").strip().lower()
        precision = _resolve_precision(config, emotion_device, torch_module)
        tf32_requested = _coerce_bool(config.get("tf32"), True)
        tf32_available = bool(
            torch_module is not None and _is_cuda_device(emotion_device)
        )
        analysis["inferenceBatchSize"] = inference_batch_size
        analysis["precisionRequested"] = precision_requested
        analysis["precision"] = precision
        analysis["tf32"] = bool(tf32_requested and tf32_available)
        analysis["precisionFallbackBatches"] = 0
        log_progress(
            "SenseVoice 情感推理配置: "
            f"batch_size={inference_batch_size}, precision={precision}, "
            f"tf32={'on' if analysis['tf32'] else 'off'}"
        )

        configured_batch_size_s = float(config.get("batch_size_s", 300) or 300)
        max_batch_chunks = config.get("max_batch_chunks", 64)
        planned_batches = build_duration_batches(
            chunks,
            max_batch_duration_s=configured_batch_size_s,
            max_batch_chunks=max_batch_chunks,
        )
        inference_started = time.perf_counter()
        timeline = []
        remaining_chunks = list(chunks)
        batch_index = 0
        while remaining_chunks:
            if gpu_throttle:
                gpu_throttle.wait_if_busy("SenseVoice 情感批次规划")
            choose_batch = getattr(gpu_throttle, "batch_size_for", None) if gpu_throttle else None
            effective_batch_size_s = (
                choose_batch("emotion", configured_batch_size_s)
                if callable(choose_batch)
                else configured_batch_size_s
            )
            current_batches = build_duration_batches(
                remaining_chunks,
                max_batch_duration_s=effective_batch_size_s,
                max_batch_chunks=max_batch_chunks,
            )
            batch = current_batches[0]
            remaining_chunks = remaining_chunks[len(batch):]
            audio_batch = []
            valid_batch = []
            for chunk in batch:
                start_index = max(0, int(float(chunk["start"]) * int(sample_rate)))
                end_index = min(len(audio_data), int(float(chunk["end"]) * int(sample_rate)))
                if end_index <= start_index:
                    continue
                audio_batch.append(audio_data[start_index:end_index])
                valid_batch.append(chunk)
            if not audio_batch:
                batch_index += 1
                continue
            if gpu_throttle:
                gpu_throttle.wait_if_busy("SenseVoice 情感批量推理")
            timeout_s = float(config.get("batch_timeout_s", 180) or 180)
            with ResourcePeakMonitor(
                payload,
                "SenseVoice 情感批量推理",
                gpu_throttle=gpu_throttle,
            ):
                with StageTimeout(timeout_s, "SenseVoice 情感批量推理"):
                    with suppress_model_output():
                        with _cuda_tf32_context(
                            emotion_device,
                            tf32_requested,
                            torch_module,
                        ):
                            results, precision_fallback = _generate_emotion_batch(
                                model,
                                audio_batch,
                                config,
                                effective_batch_size_s,
                                precision,
                                torch_module=torch_module,
                            )
            if precision_fallback:
                analysis["precisionFallbackBatches"] += 1
            for result_index, chunk in enumerate(valid_batch):
                item = _result_item(results, result_index)
                raw_text = item.get("text") or item.get("sentence") or ""
                metadata = extract_sensevoice_metadata(raw_text)
                if not _coerce_bool(config.get("include_events"), True):
                    metadata.pop("events", None)
                timeline_item = {
                    "start": chunk["start"],
                    "end": chunk["end"],
                    "text": chunk.get("text") or "",
                }
                if metadata.get("emotion"):
                    timeline_item["emotion"] = metadata["emotion"]
                if metadata.get("events"):
                    timeline_item["events"] = metadata["events"]
                timeline.append(timeline_item)
            log_progress(
                f"SenseVoice 情感进度: {batch_index + 1}/~{len(planned_batches)} "
                f"(chunks={len(valid_batch)})"
            )
            batch_index += 1

        inference_s = time.perf_counter() - inference_started
        analysis["timeline"] = timeline
        for item in timeline:
            emotion = item.get("emotion")
            if emotion:
                analysis["labeledChunks"] += 1
                analysis["emotionCounts"][emotion] = analysis["emotionCounts"].get(emotion, 0) + 1
            for event in item.get("events") or []:
                analysis["eventCounts"][event] = analysis["eventCounts"].get(event, 0) + 1
        project_emotion_timeline_to_segments(segments, timeline)
        analysis["status"] = "completed"
        analysis["timings"]["inference_s"] = inference_s
        analysis["timings"]["total_s"] = time.perf_counter() - started
        payload["_emotion_analysis"] = analysis
        log_progress(
            "SenseVoice 情感识别完成: "
            f"chunks={len(timeline)}, labeled={analysis['labeledChunks']}, "
            f"cache_hit={cache_hit}, total={analysis['timings']['total_s']:.3f}s"
        )
        return analysis
    except Exception as exc:
        analysis["status"] = "failed"
        analysis["error"] = str(exc)
        analysis["timings"]["total_s"] = time.perf_counter() - started
        payload["_emotion_analysis"] = analysis
        log_progress(f"SenseVoice 情感识别失败，保留 Paraformer 结果: {exc}")
        if not fail_open:
            raise
        return analysis
