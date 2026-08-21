import gc
import json
import os
import re
import time
import traceback
import unicodedata

from sensevoice_runtime import CpuThrottle, StageTimeout, log_progress, set_timing, suppress_model_output
from sensevoice_emotion import analyze_paraformer_emotions
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


def has_timed_segments(raw_result):
    if isinstance(raw_result, dict):
        candidates = raw_result.get("sentence_info") or raw_result.get("segments") or raw_result.get("result")
        if isinstance(candidates, list):
            return any(has_timed_segments(item) for item in candidates)
        return any(key in raw_result for key in ("start", "end", "start_time", "end_time"))
    if isinstance(raw_result, list):
        return any(has_timed_segments(item) for item in raw_result)
    return False


ASCII_WORD_RE = re.compile(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*")
SENTENCE_ENDS = set("。！？；.!?;\n")
CLAUSE_ENDS = set("，、：…—,:")


def _paraformer_text_units(text):
    units = []
    index = 0
    text = str(text or "")
    while index < len(text):
        char = text[index]
        if char.isspace():
            index += 1
            continue
        ascii_word = ASCII_WORD_RE.match(text, index)
        if ascii_word:
            units.append({"text": ascii_word.group(0), "timed": True})
            index = ascii_word.end()
            continue
        units.append({
            "text": char,
            "timed": not unicodedata.category(char).startswith("P"),
        })
        index += 1
    return units


def paraformer_full_text_to_segments(result, max_subtitle_chars=18):
    text = result.get("text", "") if isinstance(result, dict) else ""
    timestamps = result.get("timestamp") if isinstance(result, dict) else None
    if not text or not isinstance(timestamps, list) or not timestamps:
        return []

    units = _paraformer_text_units(text)
    timed_units = [unit for unit in units if unit["timed"]]
    if len(timed_units) != len(timestamps):
        return []

    timestamp_index = 0
    for unit in units:
        if not unit["timed"]:
            continue
        start_ms, end_ms = timestamps[timestamp_index]
        unit["start"] = float(start_ms) / 1000.0
        unit["end"] = float(end_ms) / 1000.0
        timestamp_index += 1

    segments = []
    current = []

    def flush():
        nonlocal current
        timed = [unit for unit in current if unit["timed"]]
        text_value = "".join(unit["text"] for unit in current).strip()
        if timed and text_value:
            segments.append({
                "start": round(timed[0]["start"], 3),
                "end": round(max(timed[-1]["end"], timed[0]["start"] + 0.1), 3),
                "text": text_value,
                "time_unit": "seconds",
            })
        current = []

    for unit in units:
        current.append(unit)
        visible_length = len("".join(item["text"] for item in current).strip())
        unit_text = unit["text"]
        should_flush = unit_text in SENTENCE_ENDS
        if unit_text in CLAUSE_ENDS and visible_length >= max_subtitle_chars * 0.6:
            should_flush = True
        elif visible_length >= max_subtitle_chars * 1.3:
            should_flush = True
        if should_flush:
            flush()
    flush()
    return segments


def select_paraformer_speaker_intervals(
    result,
    sentence_info,
    vad_intervals=None,
    max_subtitle_chars=18,
):
    """Use VAD spans with the same timestamped segments emitted as subtitles."""
    precise_segments = paraformer_full_text_to_segments(
        result,
        max_subtitle_chars=max_subtitle_chars,
    )
    sentence_intervals = [
        {
            "start": float(item["start"]),
            "end": float(item["end"]),
        }
        for item in precise_segments
        if float(item.get("end", 0)) > float(item.get("start", 0))
    ]
    sentence_source = "paraformer_subtitle_timestamps"
    if not sentence_intervals:
        sentence_intervals = [
            {
                "start": float(item.get("start", 0) or 0) / 1000.0,
                "end": float(
                    item.get("end", item.get("start", 0)) or 0
                ) / 1000.0,
            }
            for item in sentence_info or []
            if float(item.get("end", 0) or 0)
            > float(item.get("start", 0) or 0)
        ]
        sentence_source = "paraformer_sentence_info_fallback"

    normalized_vad = [
        {
            "start": max(0.0, float(item.get("start", 0) or 0)),
            "end": max(
                0.0,
                float(item.get("end", item.get("start", 0)) or 0),
            ),
        }
        for item in vad_intervals or []
        if isinstance(item, dict)
        and float(item.get("end", 0) or 0)
        > float(item.get("start", 0) or 0)
    ]
    if normalized_vad:
        return (
            normalized_vad,
            sentence_intervals,
            f"funasr_vad+{sentence_source}",
        )
    return sentence_intervals, [], sentence_source


def extract_vad_speaker_intervals(raw_result):
    """Normalize FunASR VAD inference output from milliseconds to seconds."""
    intervals = []
    for result in raw_result or []:
        if not isinstance(result, dict):
            continue
        for value in result.get("value") or []:
            if not isinstance(value, (list, tuple)) or len(value) < 2:
                continue
            start = max(0.0, float(value[0]) / 1000.0)
            end = max(start, float(value[1]) / 1000.0)
            if end > start:
                intervals.append({"start": start, "end": end})
    return intervals


def paraformer_timestamp_to_sentences(results, meta, punc_model, max_subtitle_chars=18):
    """
    Paraformer returns character-level timestamps.
    Split into subtitle-friendly sentences with precise timing.
    """
    if not results or not isinstance(results, list):
        return []

    item = results[0] if isinstance(results, list) else results
    if not isinstance(item, dict):
        return []

    raw_text = item.get("text", "")
    timestamps = item.get("timestamp")

    if not raw_text or not timestamps:
        text = restore_punctuation(punc_model, raw_text or "")
        if not text:
            return []
        return [{
            "start": meta["start"],
            "end": meta["end"],
            "text": text,
            "time_unit": "seconds",
            "speaker": meta.get("speaker"),
            "speaker_score": meta.get("speaker_score"),
        }]

    chars = raw_text.strip().split()
    if len(chars) != len(timestamps):
        text = restore_punctuation(punc_model, raw_text.replace(" ", ""))
        if not text:
            return []
        return [{
            "start": meta["start"],
            "end": meta["end"],
            "text": text,
            "time_unit": "seconds",
            "speaker": meta.get("speaker"),
            "speaker_score": meta.get("speaker_score"),
        }]

    char_ts = []
    chunk_offset = float(meta["start"])
    for ch, (start_ms, end_ms) in zip(chars, timestamps):
        char_ts.append((
            ch,
            chunk_offset + float(start_ms) / 1000.0,
            chunk_offset + float(end_ms) / 1000.0,
        ))

    joined_text = "".join(chars)
    punctuated = restore_punctuation(punc_model, joined_text)
    punctuated_chars = list(punctuated)
    original_idx = 0
    punct_to_char = {}
    for punct_idx, punct_char in enumerate(punctuated_chars):
        if original_idx < len(char_ts) and punct_char == char_ts[original_idx][0]:
            punct_to_char[punct_idx] = original_idx
            original_idx += 1

    sentence_ends = set("。！？；\n")
    clause_ends = set("，、：…—")

    sentences = []
    sent_start = 0
    for index, punct_char in enumerate(punctuated_chars):
        if punct_char in sentence_ends:
            if index > sent_start:
                sentences.append((sent_start, index + 1))
                sent_start = index + 1
    if sent_start < len(punctuated_chars):
        sentences.append((sent_start, len(punctuated_chars)))

    final_segments = []
    for sent_start_idx, sent_end_idx in sentences:
        sent_text = punctuated_chars[sent_start_idx:sent_end_idx]
        sent_text_str = "".join(sent_text).strip()
        if not sent_text_str:
            continue

        char_indices = []
        for punct_idx in range(sent_start_idx, sent_end_idx):
            if punct_idx in punct_to_char:
                char_indices.append(punct_to_char[punct_idx])

        if not char_indices:
            continue

        if len(sent_text_str) <= max_subtitle_chars:
            final_segments.append({
                "start": round(char_ts[char_indices[0]][1], 3),
                "end": round(char_ts[char_indices[-1]][2], 3),
                "text": sent_text_str,
                "time_unit": "seconds",
                "speaker": meta.get("speaker"),
                "speaker_score": meta.get("speaker_score"),
            })
            continue

        sub_start = sent_start_idx
        for punct_idx in range(sent_start_idx, sent_end_idx):
            punct_char = punctuated_chars[punct_idx]
            current_len = len("".join(punctuated_chars[sub_start:punct_idx + 1]).strip())
            should_split = False
            if punct_char in clause_ends and current_len >= max_subtitle_chars * 0.6:
                should_split = True
            elif current_len >= max_subtitle_chars and punct_char in clause_ends:
                should_split = True
            elif current_len >= max_subtitle_chars * 1.3:
                should_split = True

            if not should_split:
                continue

            sub_text = "".join(punctuated_chars[sub_start:punct_idx + 1]).strip()
            if sub_text:
                sub_char_indices = []
                for sub_idx in range(sub_start, punct_idx + 1):
                    if sub_idx in punct_to_char:
                        sub_char_indices.append(punct_to_char[sub_idx])
                if sub_char_indices:
                    final_segments.append({
                        "start": round(char_ts[sub_char_indices[0]][1], 3),
                        "end": round(char_ts[sub_char_indices[-1]][2], 3),
                        "text": sub_text,
                        "time_unit": "seconds",
                        "speaker": meta.get("speaker"),
                        "speaker_score": meta.get("speaker_score"),
                    })
            sub_start = punct_idx + 1

        remaining = "".join(punctuated_chars[sub_start:sent_end_idx]).strip()
        if not remaining:
            continue
        rem_char_indices = []
        for sub_idx in range(sub_start, sent_end_idx):
            if sub_idx in punct_to_char:
                rem_char_indices.append(punct_to_char[sub_idx])
        if rem_char_indices:
            final_segments.append({
                "start": round(char_ts[rem_char_indices[0]][1], 3),
                "end": round(char_ts[rem_char_indices[-1]][2], 3),
                "text": remaining,
                "time_unit": "seconds",
                "speaker": meta.get("speaker"),
                "speaker_score": meta.get("speaker_score"),
            })

    return final_segments


def pick_batched_result(results, index):
    if not isinstance(results, list):
        return results
    if index < len(results) and isinstance(results[index], dict):
        return [results[index]]
    return results


def normalize_model_results_with_meta(results, meta, punc_model):
    timed_segments = []
    chunk_duration = max(0.0, float(meta["end"]) - float(meta["start"]))
    has_explicit_timing = has_timed_segments(results)

    if not has_explicit_timing:
        item = results[0] if results and isinstance(results, list) else {}
        raw_text = item.get("text", "") if isinstance(item, dict) else ""
        text = restore_punctuation(punc_model, raw_text)
        if not text:
            return []
        return [{
            "start": meta["start"],
            "end": meta["end"],
            "text": text,
            "time_unit": "seconds",
            "speaker": meta.get("speaker"),
            "speaker_score": meta.get("speaker_score"),
            **extract_sensevoice_metadata(raw_text),
        }]

    raw_segments = normalize_segments(results)
    for segment in raw_segments:
        start = float(segment.get("start", 0.0))
        end = float(segment.get("end", start + 0.1))
        if start >= 0 and end <= chunk_duration + 1.0:
            start += float(meta["start"])
            end += float(meta["start"])
        segment["start"] = start
        segment["end"] = max(end, start + 0.1)
        segment["text"] = restore_punctuation(punc_model, segment.get("text", ""))
        if meta.get("speaker") and not segment.get("speaker"):
            segment["speaker"] = meta.get("speaker")
        if meta.get("speaker_score"):
            segment["speaker_score"] = meta.get("speaker_score")
        timed_segments.append(segment)

    return timed_segments


def install_paraformer_timing_probe(model, gpu_throttle=None, cpu_throttle=None):
    model._danmaku_gpu_throttle = gpu_throttle
    model._danmaku_cpu_throttle = cpu_throttle
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
    payload["_timings"] = {}
    cpu_throttle = CpuThrottle(payload)

    device_name = "cuda:0" if device == "cuda" else device
    model_name = payload.get("model", "paraformer-zh")
    resolved_model = resolve_cached_model_name(model_name)
    log_progress(f"准备 paraformer 内建 pipeline: {resolved_model}")

    model_kwargs = {
        "model": resolved_model,
        "device": device_name,
        "disable_update": True,
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
                    spk_model_obj = AutoModel(
                        model=resolve_cached_model_name(spk_model),
                        device=device_name,
                        disable_update=True,
                    )
                    cache["speaker_model"] = spk_model_obj
                    set_timing(payload, "speaker_model_load_s", time.perf_counter() - speaker_load_started)
                else:
                    set_timing(payload, "speaker_model_load_s", 0)
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
            spk_model_obj = AutoModel(
                model=resolve_cached_model_name(spk_model),
                device=device_name,
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

    if not results or not isinstance(results, list):
        _fail(fail_fn, "paraformer 无输出", "generate() 返回空结果")

    result = results[0]
    sentence_info = result.get("sentence_info", [])
    if not sentence_info:
        log_progress("无 sentence_info，使用 Paraformer 字符时间戳切分字幕")
        postprocess_started = time.perf_counter()
        timestamps = result.get("timestamp") or []
        fallback_end_s = float(timestamps[-1][1]) / 1000.0 if timestamps else 0.1
        segments = paraformer_timestamp_to_sentences(
            results,
            {"start": 0.0, "end": max(0.1, fallback_end_s)},
            None,
            max_subtitle_chars=int(payload.get("max_subtitle_chars", 18) or 18),
        )
        emotion_analysis = analyze_paraformer_emotions(
            payload,
            audio_path,
            segments,
            device,
            runtime_cache=cache,
            gpu_throttle=gpu_throttle,
        )
        emotion_timings = (emotion_analysis or {}).get("timings", {})
        set_timing(payload, "emotion_model_load_s", emotion_timings.get("model_load_s", 0))
        set_timing(payload, "emotion_inference_s", emotion_timings.get("inference_s", 0))
        set_timing(payload, "emotion_total_s", emotion_timings.get("total_s", 0))
        set_timing(payload, "speaker_cluster_embedding_s", 0)
        set_timing(payload, "speaker_matching_s", 0)
        set_timing(payload, "postprocess_s", time.perf_counter() - postprocess_started)
        set_timing(payload, "backend_total_s", time.perf_counter() - backend_started)
        payload["_speaker_processing"] = {
            "mode": "disabled" if not enable_speaker else str(payload.get("speaker_detection_mode") or "auto"),
            "status": "disabled" if not enable_speaker else "failed",
            "decision": "disabled" if not enable_speaker else "inconclusive",
            "reason": "speaker_disabled" if not enable_speaker else "missing_sentence_info",
            "full_run": False,
        }
        log_progress(
            f"字符时间戳切分完成: 输出段数={len(segments)}, "
            f"postprocess={payload['_timings']['postprocess_s']:.3f}s"
        )
        return segments

    log_progress(f"sentence_info: {len(sentence_info)} 句")

    speaker_timeline = []
    audio_data = None
    sample_rate = None
    if enable_speaker and spk_model_obj and sentence_info:
        try:
            audio_data, sample_rate = load_audio_16k_mono(audio_path)
            (
                speaker_intervals,
                speaker_boundary_intervals,
                speaker_interval_source,
            ) = (
                select_paraformer_speaker_intervals(
                    result,
                    sentence_info,
                    vad_intervals=getattr(
                        model,
                        "_danmaku_vad_intervals",
                        [],
                    ),
                    max_subtitle_chars=int(
                        payload.get("max_subtitle_chars", 18) or 18
                    ),
                )
            )
            speaker_payload = dict(payload)
            speaker_payload["speaker_interval_source"] = (
                speaker_interval_source
            )
            def load_references():
                reference_started = time.perf_counter()
                centroids = build_speaker_reference_centroids(
                    spk_model_obj,
                    speaker_references,
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
                set_timing(payload, "reference_embedding_s", time.perf_counter() - reference_started)
                return centroids

            adaptive = run_adaptive_speaker_engine(
                spk_model_obj,
                audio_data,
                sample_rate,
                speaker_intervals,
                boundary_intervals=speaker_boundary_intervals,
                payload=speaker_payload,
                references=load_references if speaker_references else None,
            )
            speaker_timeline = smooth_speaker_timeline(
                adaptive.get("timeline", []),
                float(payload.get("speaker_unknown_fill_gap_s", 10.0) or 10.0),
                float(payload.get("speaker_unknown_max_duration_s", 12.0) or 12.0),
            )
            payload["_speaker_processing"] = adaptive.get("processing", {})
            adaptive_timings = payload["_speaker_processing"].get("timings", {})
            set_timing(payload, "speaker_probe_embedding_s", adaptive_timings.get("probe_embedding_s", 0))
            set_timing(payload, "speaker_probe_clustering_s", adaptive_timings.get("probe_clustering_s", 0))
            set_timing(payload, "speaker_full_embedding_s", adaptive_timings.get("full_embedding_s", 0))
            set_timing(payload, "speaker_full_clustering_s", adaptive_timings.get("full_clustering_s", 0))
            set_timing(payload, "speaker_matching_s", adaptive_timings.get("reference_matching_s", 0))
            set_timing(payload, "speaker_total_s", adaptive_timings.get("total_s", 0))
            set_timing(payload, "speaker_cluster_embedding_s", adaptive_timings.get("full_embedding_s", 0))
        except Exception as exc:
            log_progress(f"自适应说话人处理失败，保留 ASR 结果: {exc}")
            payload["_speaker_processing"] = {
                "mode": str(payload.get("speaker_detection_mode") or "auto"),
                "status": "failed",
                "decision": "inconclusive",
                "reason": "speaker_processing_error",
                "full_run": False,
                "error": str(exc),
            }
    elif enable_speaker:
        payload["_speaker_processing"] = {
            "mode": str(payload.get("speaker_detection_mode") or "auto"),
            "status": "failed",
            "decision": "inconclusive",
            "reason": "speaker_model_unavailable",
            "full_run": False,
        }
    else:
        payload["_speaker_processing"] = {
            "mode": "disabled",
            "status": "disabled",
            "decision": "disabled",
            "reason": "speaker_disabled",
            "full_run": False,
        }

    postprocess_started = time.perf_counter()
    max_subtitle_chars = int(payload.get("max_subtitle_chars", 18) or 18)
    segments = paraformer_full_text_to_segments(result, max_subtitle_chars)
    if segments:
        log_progress(
            "使用完整 Paraformer 文本与字符时间戳重建字幕，"
            f"避开 sentence_info 对齐漂移: segments={len(segments)}"
        )
        for segment in segments:
            speaker_label, speaker_score = dominant_speaker_for_interval(
                segment["start"],
                segment["end"],
                speaker_timeline,
            )
            if speaker_label:
                segment["speaker"] = speaker_label
            if speaker_score:
                segment["speaker_score"] = speaker_score

    for sent in sentence_info if not segments else []:
        text = sent.get("text", "").strip()
        if not text:
            continue

        start_ms = float(sent.get("start", 0))
        end_ms = float(sent.get("end", 0))
        start_s = round(start_ms / 1000.0, 3)
        end_s = round(max(end_ms, start_ms + 100) / 1000.0, 3)

        speaker_label = None
        speaker_score = None
        speaker_label, speaker_score = dominant_speaker_for_interval(
            start_s,
            end_s,
            speaker_timeline,
        )

        if len(text) <= max_subtitle_chars:
            segment = {
                "start": start_s,
                "end": end_s,
                "text": text,
                "time_unit": "seconds",
            }
            if speaker_label:
                segment["speaker"] = speaker_label
            if speaker_score:
                segment["speaker_score"] = speaker_score
            segments.append(segment)
            continue

        timestamps = sent.get("timestamp", [])
        sub_texts = []
        current = ""
        for ch in text:
            current += ch
            if ch in ("，", "、", "？", "！", "；", ",", "?", "!", ";") and len(current) >= max_subtitle_chars * 0.5:
                sub_texts.append(current)
                current = ""
            elif len(current) >= max_subtitle_chars and ch in ("，", "、", ",", "、"):
                sub_texts.append(current)
                current = ""
            elif len(current) >= int(max_subtitle_chars * 1.3):
                sub_texts.append(current)
                current = ""
        if current:
            sub_texts.append(current)

        if len(sub_texts) <= 1 or not timestamps:
            segment = {
                "start": start_s,
                "end": end_s,
                "text": text,
                "time_unit": "seconds",
            }
            if speaker_label:
                segment["speaker"] = speaker_label
            if speaker_score:
                segment["speaker_score"] = speaker_score
            segments.append(segment)
            continue

        total_chars = sum(len(part) for part in sub_texts)
        total_duration = end_s - start_s
        cursor = start_s
        for index, sub_text in enumerate(sub_texts):
            if index == len(sub_texts) - 1:
                seg_end = end_s
            else:
                duration_share = (len(sub_text) / total_chars) * total_duration
                seg_end = round(cursor + duration_share, 3)
            segment = {
                "start": round(cursor, 3),
                "end": seg_end,
                "text": sub_text,
                "time_unit": "seconds",
            }
            if speaker_label:
                segment["speaker"] = speaker_label
            if speaker_score:
                segment["speaker_score"] = speaker_score
            segments.append(segment)
            cursor = seg_end

    set_timing(payload, "postprocess_s", time.perf_counter() - postprocess_started)
    emotion_analysis = analyze_paraformer_emotions(
        payload,
        audio_path,
        segments,
        device,
        runtime_cache=cache,
        gpu_throttle=gpu_throttle,
        audio_data=audio_data,
        sample_rate=sample_rate,
    )
    emotion_timings = (emotion_analysis or {}).get("timings", {})
    set_timing(payload, "emotion_model_load_s", emotion_timings.get("model_load_s", 0))
    set_timing(payload, "emotion_inference_s", emotion_timings.get("inference_s", 0))
    set_timing(payload, "emotion_total_s", emotion_timings.get("total_s", 0))
    set_timing(payload, "backend_total_s", time.perf_counter() - backend_started)
    log_progress(
        f"输出段数: {len(segments)}; backend_total={payload['_timings']['backend_total_s']:.3f}s; "
        f"postprocess={payload['_timings']['postprocess_s']:.3f}s"
    )
    return segments
