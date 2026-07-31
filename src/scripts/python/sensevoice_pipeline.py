import os
import time
import traceback

from sensevoice_paraformer import (
    normalize_model_results_with_meta,
    paraformer_timestamp_to_sentences,
    pick_batched_result,
)
from sensevoice_runtime import StageTimeout, log_progress, set_timing, suppress_model_output
from sensevoice_speaker import (
    build_speaker_reference_centroids,
    dominant_speaker_for_interval,
    load_audio_16k_mono,
    run_adaptive_speaker_engine,
    smooth_speaker_timeline,
)
from sensevoice_text import (
    generate_with_optional_hotword,
    is_meaningless_asr_text,
    load_punc_model,
    normalize_segments,
    resolve_cached_model_name,
)


def _fail(fail_fn, message, detail=None):
    if callable(fail_fn):
        fail_fn(message, detail)
    if detail:
        raise RuntimeError(f"{message}: {detail}")
    raise RuntimeError(message)


def split_vad_segments(vad_segments, max_segment_s):
    max_ms = int(float(max_segment_s or 0) * 1000)
    if max_ms <= 0:
        return vad_segments

    split_segments = []
    for start_ms, end_ms in vad_segments:
        start_ms = int(start_ms)
        end_ms = int(end_ms)
        cursor = start_ms
        while end_ms - cursor > max_ms:
            split_segments.append([cursor, cursor + max_ms])
            cursor += max_ms
        if end_ms > cursor:
            split_segments.append([cursor, end_ms])
    return split_segments


def get_safe_asr_segment_s(payload):
    requested = float(payload.get("max_vad_segment_s", 8) or 8)
    cap = float(payload.get("asr_max_segment_s", 8) or 8)
    if requested > cap:
        log_progress(
            f"ASR 转写块已限制为 {cap:g}s，避免长音频块漏字 "
            f"(requested max_vad_segment_s={requested:g}s)"
        )
    return min(requested, cap)


def import_vllm_pipeline(fail_fn=None):
    try:
        import vllm  # noqa: F401
    except ImportError:
        _fail(
            fail_fn,
            "vLLM 未安装，无法使用 fun_asr_nano_vllm",
            "请在当前 Python 环境安装 vLLM 及匹配 CUDA/PyTorch 依赖；也可以临时改用 --asr-backend fun_asr_nano 或 sensevoice。",
        )
    try:
        from funasr.models.fun_asr_nano.inference_vllm_pipeline import FunASRNanoVLLMPipeline

        return FunASRNanoVLLMPipeline
    except ImportError as exc:
        _fail(
            fail_fn,
            "当前 FunASR 包缺少 Fun-ASR-Nano vLLM pipeline",
            f"{exc}\n请升级 funasr，或使用 fun_asr_nano 非 vLLM 后端。",
        )


def transcribe_with_vllm_pipeline(payload, audio_path, device, gpu_throttle=None, fail_fn=None):
    backend_started = time.perf_counter()
    payload["_timings"] = {}
    if device == "cuda":
        try:
            import torch

            if not torch.cuda.is_available():
                _fail(fail_fn, "CUDA 不可用", "fun_asr_nano_vllm 配置 device=cuda，但 torch.cuda.is_available() 为 False")
        except ImportError:
            _fail(fail_fn, "CUDA 检查失败", "未安装 torch，无法使用 fun_asr_nano_vllm")

    FunASRNanoVLLMPipeline = import_vllm_pipeline(fail_fn=fail_fn)
    resolved_model = resolve_cached_model_name(payload.get("model", "FunAudioLLM/Fun-ASR-Nano-2512"))
    resolved_vad_model = resolve_cached_model_name(payload.get("vad_model", "fsmn-vad")) if payload.get("vad_model") else None
    resolved_spk_model = None
    if payload.get("enable_speaker") and not payload.get("spk_model"):
        _fail(fail_fn, "说话人分离已启用但 spk_model 未配置", "例如 spk_model=cam++")

    device_name = "cuda:0" if device == "cuda" else device
    hotwords = payload.get("hotwords") if isinstance(payload.get("hotwords"), list) else []
    log_progress(
        "加载 Fun-ASR-Nano vLLM pipeline: "
        f"model={resolved_model}, vad={resolved_vad_model}, spk={resolved_spk_model}, "
        f"tp={payload.get('tensor_parallel_size', 1)}, dtype={payload.get('dtype', 'bf16')}"
    )

    try:
        if gpu_throttle:
            gpu_throttle.wait_if_busy("Fun-ASR-Nano vLLM pipeline 加载")
        with StageTimeout(payload.get("model_load_timeout_s", 600), "Fun-ASR-Nano vLLM pipeline 加载"):
            model = FunASRNanoVLLMPipeline(
                model=resolved_model,
                vad_model=resolved_vad_model,
                vad_kwargs=payload.get("vad_kwargs") or None,
                spk_model=None,
                spk_kwargs=None,
                hub=payload.get("hub", "ms"),
                device=device_name,
                dtype=payload.get("dtype", "bf16"),
                tensor_parallel_size=int(payload.get("tensor_parallel_size", 1) or 1),
                gpu_memory_utilization=float(payload.get("gpu_memory_utilization", 0.8) or 0.8),
                max_model_len=int(payload.get("max_model_len", 4096) or 4096),
                enforce_eager=bool(payload.get("enforce_eager", False)),
            )
        log_progress("Fun-ASR-Nano vLLM pipeline 加载完成，开始转写")
        if gpu_throttle:
            gpu_throttle.wait_if_busy("Fun-ASR-Nano vLLM 转写")
        with StageTimeout(payload.get("asr_timeout_s", payload.get("process_timeout_s", 3600)), "Fun-ASR-Nano vLLM 转写"):
            with suppress_model_output():
                results = model.generate(
                    audio_path,
                    hotwords=hotwords,
                    language=payload.get("language", "中文"),
                    itn=bool(payload.get("use_itn", True)),
                    max_new_tokens=int(payload.get("max_new_tokens", 512) or 512),
                    batch_size_s=int(float(payload.get("batch_size_s", 300) or 300)),
                    return_spk_res=False,
                    preset_spk_num=None,
                )
        normalized = normalize_segments(results)
        if payload.get("enable_speaker"):
            try:
                from funasr import AutoModel

                speaker_load_started = time.perf_counter()
                spk_model_obj = AutoModel(
                    model=resolve_cached_model_name(payload.get("spk_model")),
                    device=device_name,
                    disable_update=True,
                )
                set_timing(payload, "speaker_model_load_s", time.perf_counter() - speaker_load_started)
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
                timeline = adaptive.get("timeline", [])
                for item in normalized:
                    speaker, score = dominant_speaker_for_interval(
                        item.get("start", 0), item.get("end", 0), timeline
                    )
                    if speaker:
                        item["speaker"] = speaker
                    if score:
                        item["speaker_score"] = score
                payload["_speaker_processing"] = adaptive.get("processing", {})
                adaptive_timings = payload["_speaker_processing"].get("timings", {})
                set_timing(payload, "speaker_probe_embedding_s", adaptive_timings.get("probe_embedding_s", 0))
                set_timing(payload, "speaker_probe_clustering_s", adaptive_timings.get("probe_clustering_s", 0))
                set_timing(payload, "speaker_full_embedding_s", adaptive_timings.get("full_embedding_s", 0))
                set_timing(payload, "speaker_full_clustering_s", adaptive_timings.get("full_clustering_s", 0))
                set_timing(payload, "speaker_matching_s", adaptive_timings.get("reference_matching_s", 0))
                set_timing(payload, "speaker_total_s", adaptive_timings.get("total_s", 0))
            except Exception as exc:
                log_progress(f"vLLM 自适应说话人处理失败，保留 ASR 结果: {exc}")
                payload["_speaker_processing"] = {
                    "mode": str(payload.get("speaker_detection_mode") or "auto"),
                    "status": "failed",
                    "decision": "inconclusive",
                    "reason": "speaker_processing_error",
                    "full_run": False,
                    "error": str(exc),
                }
        else:
            payload["_speaker_processing"] = {
                "mode": "disabled", "status": "disabled", "decision": "disabled",
                "reason": "speaker_disabled", "full_run": False,
            }
        set_timing(payload, "backend_total_s", time.perf_counter() - backend_started)
        log_progress("Fun-ASR-Nano vLLM 转写完成")
        return normalized
    except SystemExit:
        raise
    except Exception as exc:
        _fail(
            fail_fn,
            "Fun-ASR-Nano vLLM 转写失败",
            f"{exc}\n{traceback.format_exc()}\n可先改用 fun_asr_nano 非 vLLM 后端验证热词。",
        )


def transcribe_segmented_backend(payload, audio_path, device, backend_name, AutoModel, gpu_throttle=None, fail_fn=None):
    backend_started = time.perf_counter()
    payload["_timings"] = {}
    enable_speaker = bool(payload.get("enable_speaker", False))
    payload["_speaker_processing"] = {
        "mode": "disabled" if not enable_speaker else str(payload.get("speaker_detection_mode") or "auto"),
        "status": "disabled" if not enable_speaker else "failed",
        "decision": "disabled" if not enable_speaker else "inconclusive",
        "reason": "speaker_disabled" if not enable_speaker else "not_processed",
        "full_run": False,
    }
    default_model = (
        "FunAudioLLM/Fun-ASR-Nano-2512" if backend_name == "fun_asr_nano"
        else "paraformer-zh" if backend_name == "paraformer"
        else "iic/SenseVoiceSmall"
    )
    model_name = payload.get("model", default_model)
    resolved_model = resolve_cached_model_name(model_name)
    log_progress(f"准备主模型: {model_name} (backend={backend_name})")
    if isinstance(resolved_model, str) and resolved_model == model_name and model_name.startswith("iic/"):
        try:
            log_progress(f"下载/解析模型缓存: {model_name}")
            from modelscope import snapshot_download

            resolved_model = snapshot_download(model_name)
        except Exception as exc:
            _fail(
                fail_fn,
                "ASR 模型下载失败",
                f"{model_name}: {exc}\n请检查网络、ModelScope 访问和缓存目录权限。",
            )

    model_kwargs = {
        "model": resolved_model,
        "device": "cuda:0" if device == "cuda" else device,
        "disable_update": True,
    }
    if backend_name == "fun_asr_nano" or "SenseVoice" in model_name or "Fun-ASR-Nano" in model_name:
        model_kwargs["trust_remote_code"] = True
        model_py = os.path.join(resolved_model, "model.py") if os.path.isdir(resolved_model) else "./model.py"
        if os.path.exists(model_py):
            model_kwargs["remote_code"] = model_py

    try:
        log_progress(f"加载主模型: {resolved_model}")
        if gpu_throttle:
            gpu_throttle.wait_if_busy("主模型加载")
        model_started = time.perf_counter()
        with StageTimeout(payload.get("model_load_timeout_s", 180), "主模型加载"):
            model = AutoModel(**model_kwargs)
        set_timing(payload, "model_load_s", time.perf_counter() - model_started)
        log_progress("主模型加载完成")
    except Exception as exc:
        _fail(
            fail_fn,
            "ASR 模型加载失败",
            f"{exc}\n可能是模型首次下载失败、网络不可用、模型名错误或 CUDA 环境异常。",
        )

    punc_model_obj = load_punc_model(AutoModel, payload, device, gpu_throttle)
    if punc_model_obj:
        log_progress("标点模型加载完成")

    try:
        vad_model_name = resolve_cached_model_name(payload.get("vad_model", "fsmn-vad"))
        log_progress(f"加载 VAD 模型: {vad_model_name}")
        if gpu_throttle:
            gpu_throttle.wait_if_busy("VAD 模型加载")
        with StageTimeout(payload.get("model_load_timeout_s", 180), "VAD 模型加载"):
            vad_model = AutoModel(
                model=vad_model_name,
                device="cuda:0" if device == "cuda" else device,
                disable_update=True,
            )
        log_progress("VAD 模型加载完成，开始 VAD")
        if gpu_throttle:
            gpu_throttle.wait_if_busy("VAD 处理")
        vad_started = time.perf_counter()
        with StageTimeout(payload.get("vad_timeout_s", 180), "VAD 处理"):
            with suppress_model_output():
                vad_result = vad_model.generate(input=audio_path)
        set_timing(payload, "vad_s", time.perf_counter() - vad_started)
        vad_segments = vad_result[0].get("value") if vad_result and isinstance(vad_result, list) else []
        log_progress(f"VAD 完成: segments={len(vad_segments)}")
        raw_vad_segments = list(vad_segments)

        from funasr.utils.vad_utils import merge_vad as merge_vad_segments

        merge_length_ms = int(float(payload.get("merge_length_s", 8)) * 1000)
        if merge_length_ms > 0:
            vad_segments = merge_vad_segments(vad_segments, merge_length_ms)
        asr_max_segment_s = get_safe_asr_segment_s(payload)
        vad_segments = split_vad_segments(vad_segments, asr_max_segment_s)
        log_progress(
            f"VAD 合并/切分后: segments={len(vad_segments)}, "
            f"merge_length_s={payload.get('merge_length_s', 8)}, "
            f"max_vad_segment_s={payload.get('max_vad_segment_s', 8)}, "
            f"asr_max_segment_s={asr_max_segment_s:g}"
        )

        raw_result = []
        if not vad_segments:
            set_timing(payload, "backend_total_s", time.perf_counter() - backend_started)
            if enable_speaker:
                payload["_speaker_processing"].update({
                    "status": "skipped_single_speaker",
                    "decision": "single",
                    "reason": "no_speech",
                })
            return raw_result

        log_progress("加载音频到内存")
        audio, sample_rate = load_audio_16k_mono(audio_path)
        log_progress(f"音频加载完成: duration={len(audio) / sample_rate:.1f}s, sample_rate={sample_rate}")
        batch_size_s = float(payload.get("batch_size_s", 60))
        batch_audio = []
        batch_meta = []
        batch_duration = 0.0
        transcribed_segments = 0
        total_segments = len(vad_segments)
        spk_model = payload.get("spk_model")

        spk_model_obj = None
        if enable_speaker:
            try:
                resolved_spk_model = resolve_cached_model_name(spk_model)
                log_progress(f"准备 ASR 后自适应说话人处理: {resolved_spk_model}")
                if gpu_throttle:
                    gpu_throttle.wait_if_busy("说话人模型加载")
                speaker_load_started = time.perf_counter()
                with StageTimeout(payload.get("model_load_timeout_s", 180), "说话人模型加载"):
                    spk_model_obj = AutoModel(
                        model=resolved_spk_model,
                        device="cuda:0" if device == "cuda" else device,
                        disable_update=True,
                    )
                set_timing(payload, "speaker_model_load_s", time.perf_counter() - speaker_load_started)
            except Exception as exc:
                log_progress(f"说话人模型加载失败，保留 ASR 结果: {exc}")
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

        def flush_batch():
            nonlocal batch_audio, batch_meta, batch_duration, raw_result, transcribed_segments
            if not batch_audio:
                return
            if backend_name == "paraformer" and len(batch_audio) > 1 and not is_finetuned_paraformer:
                transcribed_segments += len(batch_audio)
                pct = transcribed_segments / max(total_segments, 1) * 100
                log_progress(
                    f"转写进度: {pct:.1f}% ({transcribed_segments}/{total_segments}, "
                    f"batch={len(batch_audio)}, audio={batch_duration:.1f}s)"
                )
                if gpu_throttle:
                    gpu_throttle.wait_if_busy("paraformer batch 转写")
                batch_timeout_s = payload.get(
                    "batch_timeout_s",
                    payload.get("segment_timeout_s", 90) * len(batch_audio),
                )
                with StageTimeout(batch_timeout_s, "paraformer batch 转写"):
                    with suppress_model_output():
                        batch_results = generate_with_optional_hotword(
                            model,
                            payload,
                            backend_name,
                            input=batch_audio,
                            language=payload.get("language", "auto"),
                            use_itn=bool(payload.get("use_itn", True)),
                            batch_size_s=batch_size_s,
                        )
                for index, meta in enumerate(batch_meta):
                    results = pick_batched_result(batch_results, index)
                    normalized_items = paraformer_timestamp_to_sentences(
                        results,
                        meta,
                        punc_model_obj,
                        max_subtitle_chars=int(payload.get("max_subtitle_chars", 18) or 18),
                    )
                    for item in normalized_items:
                        if is_meaningless_asr_text(item.get("text", "")):
                            item["speaker"] = None
                    raw_result.extend(normalized_items)
                batch_audio = []
                batch_meta = []
                batch_duration = 0.0
                return

            if backend_name == "paraformer" and is_finetuned_paraformer and len(batch_audio) > 1:
                log_progress(
                    f"finetuned paraformer 使用保守单段模式: batch={len(batch_audio)}, audio={batch_duration:.1f}s"
                )
            for meta, chunk in zip(batch_meta, batch_audio):
                transcribed_segments += 1
                if transcribed_segments == 1 or transcribed_segments % 5 == 0 or transcribed_segments == total_segments:
                    pct = transcribed_segments / max(total_segments, 1) * 100
                    log_progress(f"转写进度: {pct:.1f}% ({transcribed_segments}/{total_segments})")
                if gpu_throttle:
                    gpu_throttle.wait_if_busy("单段转写")
                with StageTimeout(payload.get("segment_timeout_s", 90), "单段转写"):
                    with suppress_model_output():
                        results = generate_with_optional_hotword(
                            model,
                            payload,
                            backend_name,
                            input=chunk,
                            language=payload.get("language", "auto"),
                            use_itn=bool(payload.get("use_itn", True)),
                            batch_size_s=batch_size_s,
                        )
                if backend_name == "paraformer":
                    normalized_items = paraformer_timestamp_to_sentences(
                        results,
                        meta,
                        punc_model_obj,
                        max_subtitle_chars=int(payload.get("max_subtitle_chars", 18) or 18),
                    )
                else:
                    normalized_items = normalize_model_results_with_meta(results, meta, punc_model_obj)
                for item in normalized_items:
                    if is_meaningless_asr_text(item.get("text", "")):
                        item["speaker"] = None
                raw_result.extend(normalized_items)
            batch_audio = []
            batch_meta = []
            batch_duration = 0.0

        asr_started = time.perf_counter()
        log_progress("开始分段转写")
        for start_ms, end_ms in vad_segments:
            start = max(0.0, float(start_ms) / 1000.0)
            end = max(start, float(end_ms) / 1000.0)
            start_idx = max(0, int(start * sample_rate))
            end_idx = min(len(audio), int(end * sample_rate))
            if end_idx <= start_idx:
                continue
            chunk = audio[start_idx:end_idx]
            duration = end - start
            if batch_audio and batch_duration + duration > batch_size_s:
                flush_batch()
            batch_audio.append(chunk)
            batch_meta.append({
                "start": start,
                "end": end,
            })
            batch_duration += duration
        flush_batch()
        set_timing(payload, "asr_inference_s", time.perf_counter() - asr_started)
        if enable_speaker and spk_model_obj and raw_result:
            try:
                def load_references():
                    reference_started = time.perf_counter()
                    centroids = build_speaker_reference_centroids(
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
                    set_timing(payload, "reference_embedding_s", time.perf_counter() - reference_started)
                    return centroids

                probe_intervals = [
                    {"start": item.get("start", 0), "end": item.get("end", 0)}
                    for item in raw_result
                    if float(item.get("end", 0) or 0) > float(item.get("start", 0) or 0)
                ]
                full_intervals = [
                    {"start": float(start) / 1000.0, "end": float(end) / 1000.0}
                    for start, end in raw_vad_segments
                ]
                speaker_payload = dict(payload)
                speaker_payload["speaker_interval_source"] = (
                    "fsmn_vad+paraformer_segments"
                    if full_intervals and probe_intervals
                    else "fsmn_vad"
                    if full_intervals
                    else "paraformer_segments"
                )
                adaptive = run_adaptive_speaker_engine(
                    spk_model_obj,
                    audio,
                    sample_rate,
                    full_intervals or probe_intervals,
                    boundary_intervals=(
                        probe_intervals if full_intervals else None
                    ),
                    payload=speaker_payload,
                    references=load_references if payload.get("speaker_references") else None,
                )
                speaker_timeline = smooth_speaker_timeline(
                    adaptive.get("timeline", []),
                    float(payload.get("speaker_unknown_fill_gap_s", 10.0) or 10.0),
                    float(payload.get("speaker_unknown_max_duration_s", 12.0) or 12.0),
                )
                for item in raw_result:
                    if is_meaningless_asr_text(item.get("text", "")):
                        item["speaker"] = None
                        continue
                    speaker, speaker_score = dominant_speaker_for_interval(
                        item.get("start", 0), item.get("end", 0), speaker_timeline
                    )
                    if speaker:
                        item["speaker"] = speaker
                    if speaker_score:
                        item["speaker_score"] = speaker_score
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
        set_timing(payload, "backend_total_s", time.perf_counter() - backend_started)
        log_progress(f"分段转写完成: output_segments={len(raw_result)}")
        return raw_result
    except SystemExit:
        raise
    except Exception as exc:
        _fail(fail_fn, "ASR 转写失败", f"{exc}\n{traceback.format_exc()}")
