import json
import contextlib
import os
import re
import sys
import traceback


def fail(message, detail=None, code=1):
    payload = {"error": message}
    if detail:
        payload["detail"] = detail
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(code)


def load_payload():
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            fail("SenseVoice 输入为空，请通过 stdin 传入 JSON 配置")
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        fail("SenseVoice 输入不是有效 JSON", str(exc))


TAG_RE = re.compile(r"<\|[^|]+?\|>")


def clean_text(text):
    return TAG_RE.sub("", str(text or "")).strip()


def normalize_segments(raw_result):
    if isinstance(raw_result, dict):
        candidates = raw_result.get("sentence_info") or raw_result.get("segments") or raw_result.get("result")
        if isinstance(candidates, list):
            return normalize_segments(candidates)
        text = clean_text(raw_result.get("text"))
        if text:
            return [{"start": 0.0, "end": 0.1, "text": text}]
        return []

    if not isinstance(raw_result, list):
        return []

    segments = []
    for item in raw_result:
        if isinstance(item, dict) and isinstance(item.get("sentence_info"), list):
            segments.extend(normalize_segments(item["sentence_info"]))
            continue

        if not isinstance(item, dict):
            continue

        text = clean_text(item.get("text") or item.get("sentence") or "")
        if not text:
            continue

        start_raw = item.get("start", item.get("start_time", 0))
        end_raw = item.get("end", item.get("end_time", start_raw))

        # FunASR sentence_info usually uses milliseconds.
        start = float(start_raw or 0)
        end = float(end_raw or 0)
        if item.get("time_unit") != "seconds" and (start > 1000 or end > 1000):
            start /= 1000.0
            end /= 1000.0
        if end <= start:
            end = start + 0.1

        speaker = item.get("spk") or item.get("speaker")
        segment = {"start": start, "end": end, "text": text}
        if speaker is not None:
            segment["speaker"] = str(speaker)
        segments.append(segment)

    return segments


HOTWORD_UNSUPPORTED_WARNED = False


def generate_with_optional_hotword(model, payload, **kwargs):
    global HOTWORD_UNSUPPORTED_WARNED
    hotword = str(payload.get("hotword") or "").strip()
    if not hotword:
        return model.generate(**kwargs)

    try:
        return model.generate(**kwargs, hotword=hotword)
    except Exception as exc:
        if not HOTWORD_UNSUPPORTED_WARNED:
            print(
                f"⚠️ SenseVoice/FunASR 当前版本不支持或无法使用 hotword 参数，"
                f"已降级为无 hotword 转写并保留后处理 corrections: {exc}",
                file=sys.stderr,
            )
            HOTWORD_UNSUPPORTED_WARNED = True
        return model.generate(**kwargs)


def main():
    payload = load_payload()
    audio_path = payload.get("audio_path")
    if not audio_path or not os.path.exists(audio_path):
        fail("输入音频不存在", audio_path or "未提供 audio_path")

    try:
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

    enable_speaker = bool(payload.get("enable_speaker", False))
    spk_model = payload.get("spk_model")
    if enable_speaker and not spk_model:
        fail("说话人分离已启用但 spk_model 未配置", "例如 spk_model=cam++")

    original_stdout = sys.stdout
    with contextlib.redirect_stdout(sys.stderr):
        model_name = payload.get("model", "iic/SenseVoiceSmall")
        resolved_model = model_name
        if isinstance(model_name, str) and model_name.startswith("iic/"):
            try:
                from modelscope import snapshot_download
                resolved_model = snapshot_download(model_name)
            except Exception as exc:
                fail(
                    "SenseVoice 模型下载失败",
                    f"{model_name}: {exc}\n请检查网络、ModelScope 访问和缓存目录权限。",
                )

        model_kwargs = {
            "model": resolved_model,
            "device": "cuda:0" if device == "cuda" else device,
            "disable_update": True,
        }
        if "SenseVoice" in model_name:
            model_kwargs["trust_remote_code"] = True
            model_py = os.path.join(resolved_model, "model.py") if os.path.isdir(resolved_model) else "./model.py"
            model_kwargs["remote_code"] = model_py

        try:
            model = AutoModel(**model_kwargs)
        except Exception as exc:
            fail(
                "SenseVoice/FunASR 模型加载失败",
                f"{exc}\n可能是模型首次下载失败、网络不可用、模型名错误或 CUDA 环境异常。",
            )

        try:
            vad_model = AutoModel(
                model=payload.get("vad_model", "fsmn-vad"),
                device="cuda:0" if device == "cuda" else device,
                disable_update=True,
            )
            vad_result = vad_model.generate(input=audio_path)
            vad_segments = vad_result[0].get("value") if vad_result and isinstance(vad_result, list) else []

            from funasr.utils.vad_utils import merge_vad as merge_vad_segments
            merge_length_ms = int(float(payload.get("merge_length_s", 15)) * 1000)
            if merge_length_ms > 0:
                vad_segments = merge_vad_segments(vad_segments, merge_length_ms)

            raw_result = []
            if vad_segments:
                import librosa
                import torch
                audio, sample_rate = librosa.load(audio_path, sr=16000, mono=True)
                batch_size_s = float(payload.get("batch_size_s", 60))
                batch_audio = []
                batch_meta = []
                batch_duration = 0.0
                speaker_labels = {}

                if enable_speaker:
                    try:
                        spk_model_obj = AutoModel(
                            model=spk_model,
                            device="cuda:0" if device == "cuda" else device,
                            disable_update=True,
                        )
                        from funasr.models.campplus.cluster_backend import ClusterBackend

                        speaker_chunks = []
                        speaker_chunk_to_segment = []
                        for seg_index, (start_ms, end_ms) in enumerate(vad_segments):
                            start = max(0.0, float(start_ms) / 1000.0)
                            end = max(start, float(end_ms) / 1000.0)
                            start_idx = max(0, int(start * sample_rate))
                            end_idx = min(len(audio), int(end * sample_rate))
                            if end_idx <= start_idx:
                                continue
                            speaker_chunks.append(audio[start_idx:end_idx])
                            speaker_chunk_to_segment.append(seg_index)

                        if speaker_chunks:
                            spk_results = spk_model_obj.generate(
                                input=speaker_chunks,
                                cache={},
                                is_final=True,
                            )
                            embeddings = torch.cat([r["spk_embedding"] for r in spk_results], dim=0)
                            cluster = ClusterBackend(
                                merge_thr=float(payload.get("speaker_merge_threshold", 0.78))
                            ).to("cuda:0" if device == "cuda" else device)
                            preset_spk_num = payload.get("preset_spk_num")
                            labels = cluster(
                                embeddings.cpu(),
                                oracle_num=int(preset_spk_num) if preset_spk_num else None,
                            )
                            for seg_index, label in zip(speaker_chunk_to_segment, labels):
                                speaker_labels[seg_index] = f"SPEAKER_{int(label):02d}"
                    except Exception as exc:
                        fail(
                            "说话人分离失败",
                            f"{exc}\n可先关闭 enable_speaker，或检查 spk_model/preset_spk_num/CAM++ 依赖。",
                        )

                def flush_batch():
                    nonlocal batch_audio, batch_meta, batch_duration, raw_result
                    if not batch_audio:
                        return
                    for meta, chunk in zip(batch_meta, batch_audio):
                        results = generate_with_optional_hotword(
                            model,
                            payload,
                            input=chunk,
                            language=payload.get("language", "auto"),
                            use_itn=bool(payload.get("use_itn", True)),
                            batch_size_s=batch_size_s,
                        )
                        item = results[0] if results and isinstance(results, list) else {}
                        text = clean_text(item.get("text", "") if isinstance(item, dict) else "")
                        if text:
                            raw_result.append({
                                "start": meta["start"],
                                "end": meta["end"],
                                "text": text,
                                "time_unit": "seconds",
                                "speaker": meta.get("speaker"),
                            })
                    batch_audio = []
                    batch_meta = []
                    batch_duration = 0.0

                for seg_index, (start_ms, end_ms) in enumerate(vad_segments):
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
                        "speaker": speaker_labels.get(seg_index),
                    })
                    batch_duration += duration
                flush_batch()
        except Exception as exc:
            fail("SenseVoice 转写失败", f"{exc}\n{traceback.format_exc()}")

    output = {
        "backend": "sensevoice",
        "language": payload.get("language", "auto"),
        "segments": normalize_segments(raw_result),
    }
    if payload.get("include_raw", False):
        output["raw"] = raw_result
    print(json.dumps(output, ensure_ascii=False, default=str), file=original_stdout)


if __name__ == "__main__":
    main()
