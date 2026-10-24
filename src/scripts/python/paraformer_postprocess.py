"""Post-ASR speaker/emotion stages shared by live-cache reuse and offline inference."""
import time
from types import SimpleNamespace
from sensevoice_runtime import log_progress, set_timing
from sensevoice_text import resolve_cached_model_name
from sensevoice_emotion import analyze_paraformer_emotions
from speaker_identity import attach_speaker_evidence
from sensevoice_speaker import (build_speaker_reference_centroids, dominant_speaker_for_interval,
    load_audio_16k_mono, run_adaptive_speaker_engine, smooth_speaker_timeline)
from paraformer_segments import (paraformer_timestamp_to_sentences, paraformer_full_text_to_segments,
    select_paraformer_speaker_intervals)


def _fail(fail_fn, message, detail=None):
    if callable(fail_fn):
        fail_fn(message, detail)
    raise RuntimeError(f'{message}: {detail or ""}')


def postprocess_paraformer(payload, audio_path, device, results, model, spk_model_obj, cache,
                          gpu_throttle, backend_started, enable_speaker, speaker_references, fail_fn=None,
                          audio_data=None, sample_rate=None):
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
            audio_data=audio_data,
            sample_rate=sample_rate,
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
            "reason": ((payload.get('speaker_processing_policy') or {}).get('reason', 'speaker_disabled')
                if (payload.get('speaker_processing_policy') or {}).get('enabled') is False
                else "speaker_disabled" if not enable_speaker else "missing_sentence_info"),
            "full_run": False,
            "load_policy": payload.get('speaker_processing_policy'),
        }
        log_progress(
            f"字符时间戳切分完成: 输出段数={len(segments)}, "
            f"postprocess={payload['_timings']['postprocess_s']:.3f}s"
        )
        return segments

    log_progress(f"sentence_info: {len(sentence_info)} 句")

    speaker_timeline = []
    if enable_speaker and spk_model_obj and sentence_info:
        try:
            if audio_data is None:
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
                    gpu_throttle=gpu_throttle,
                    payload=payload,
                    runtime_cache=cache,
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
                gpu_throttle=gpu_throttle,
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
            "reason": ((payload.get('speaker_processing_policy') or {}).get('reason', 'speaker_disabled')
                if (payload.get('speaker_processing_policy') or {}).get('enabled') is False else 'speaker_disabled'),
            "full_run": False,
            "load_policy": payload.get('speaker_processing_policy'),
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

    for segment in segments:
        attach_speaker_evidence(segment, speaker_timeline, payload.get("speaker_identity_policy", "legacy"))
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


def postprocess_cached_paraformer(payload, audio_path, device, results, cache, gpu_throttle, started):
    from funasr import AutoModel
    speaker = None
    enabled = bool(payload.get('enable_speaker', False))
    if not enabled and (payload.get('speaker_processing_policy') or {}).get('enabled') is False:
        log_progress('说话人处理策略跳过: ' + str(payload['speaker_processing_policy'].get('reason')))
    audio_data, sample_rate = None, None
    if enabled or (payload.get('emotion_analysis') or {}).get('enabled'):
        audio_data, sample_rate = load_audio_16k_mono(audio_path, align_timestamps=True)
    if enabled and payload.get('spk_model'):
        try:
            began = time.perf_counter()
            if gpu_throttle:
                gpu_throttle.wait_if_busy('缓存转写后的说话人模型加载')
            speaker = AutoModel(model=resolve_cached_model_name(payload['spk_model']),
                                device=device, ncpu=2 if device == 'cpu' else 4, disable_update=True)
            set_timing(payload, 'speaker_model_load_s', time.perf_counter()-began)
        except Exception as exc:
            log_progress(f'说话人模型加载失败，保留实时转写: {exc}')
    # Sentence/character intervals remain available for the existing adaptive speaker engine.
    return postprocess_paraformer(payload, audio_path, device, results,
        SimpleNamespace(_danmaku_vad_intervals=[]), speaker, cache, gpu_throttle, started,
        enabled, payload.get('speaker_references'), audio_data=audio_data, sample_rate=sample_rate)
