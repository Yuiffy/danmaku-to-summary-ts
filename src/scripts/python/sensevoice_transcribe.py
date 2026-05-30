import json
import contextlib
import os
import re
import signal
import sys
import traceback


def log_progress(message):
    print(f"[SenseVoice] {message}", file=sys.stderr, flush=True)


@contextlib.contextmanager
def suppress_model_output():
    """FunASR prints tqdm/rtf diagnostics to stdout/stderr for every generate call."""
    with open(os.devnull, "w", encoding="utf-8") as devnull:
        with contextlib.redirect_stdout(devnull), contextlib.redirect_stderr(devnull):
            yield


class StageTimeout:
    def __init__(self, seconds, label):
        self.seconds = int(float(seconds or 0))
        self.label = label
        self.previous_handler = None

    def __enter__(self):
        if self.seconds <= 0 or not hasattr(signal, "SIGALRM"):
            return self
        self.previous_handler = signal.getsignal(signal.SIGALRM)

        def _handler(_signum, _frame):
            raise TimeoutError(f"{self.label} 超时 {self.seconds}s")

        signal.signal(signal.SIGALRM, _handler)
        signal.alarm(self.seconds)
        return self

    def __exit__(self, exc_type, exc, tb):
        if self.seconds > 0 and hasattr(signal, "SIGALRM"):
            signal.alarm(0)
            signal.signal(signal.SIGALRM, self.previous_handler)
        return False


def fail(message, detail=None, code=1):
    payload = {"error": message}
    if detail:
        payload["detail"] = detail
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(code)


def load_payload():
    try:
        raw_bytes = sys.stdin.buffer.read()
        raw = raw_bytes.decode("utf-8-sig").lstrip("\ufeff")
        if not raw.strip():
            fail("SenseVoice 输入为空，请通过 stdin 传入 JSON 配置")
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        fail("SenseVoice 输入不是有效 JSON", str(exc))


TAG_RE = re.compile(r"<\|[^|]+?\|>")
MODELSCOPE_IIC_DIR = os.path.join(os.path.expanduser("~"), ".cache", "modelscope", "hub", "models", "iic")
MODEL_ALIASES = {
    "iic/SenseVoiceSmall": "SenseVoiceSmall",
    "SenseVoiceSmall": "SenseVoiceSmall",
    "fsmn-vad": "speech_fsmn_vad_zh-cn-16k-common-pytorch",
    "ct-punc": "punc_ct-transformer_cn-en-common-vocab471067-large",
    "cam++": "speech_campplus_sv_zh-cn_16k-common",
}


def clean_text(text):
    return TAG_RE.sub("", str(text or "")).strip()


def clean_punctuation_text(text):
    cleaned = clean_text(text)
    punctuation = set("，。！？；：,.?!;:")
    sentence_end = set("。！？.?!")
    comma_like = set("，,")
    result = []
    for char in cleaned:
        if result and char in punctuation and result[-1] in punctuation:
            if result[-1] == char:
                continue
            if result[-1] in comma_like and char in sentence_end:
                result[-1] = char
                continue
            if result[-1] in sentence_end:
                continue
        result.append(char)
    return "".join(result).strip()


def is_meaningless_asr_text(text):
    cleaned = clean_text(text).strip()
    if not cleaned:
        return True
    if re.fullmatch(r"[\s\W_.。，！？!?]+", cleaned):
        return True
    if cleaned.lower() in {"i", "i.", "yeah", "yeah.", "ok", "okay"}:
        return True
    meaningful = re.sub(r"[\s\W_.。，！？!?]+", "", cleaned)
    return len(meaningful) <= 1


def resolve_cached_model_name(model_name):
    if not model_name:
        return model_name
    model_text = str(model_name)
    if os.path.exists(model_text):
        return model_text
    alias = MODEL_ALIASES.get(model_text)
    if alias:
        candidate = os.path.join(MODELSCOPE_IIC_DIR, alias)
        if os.path.exists(candidate):
            log_progress(f"使用本地模型缓存: {model_text} -> {candidate}")
            return candidate
    if model_text.startswith("iic/"):
        candidate = os.path.join(MODELSCOPE_IIC_DIR, model_text.split("/", 1)[1])
        if os.path.exists(candidate):
            log_progress(f"使用本地模型缓存: {model_text} -> {candidate}")
            return candidate
    return model_name


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
        if item.get("speaker_score"):
            segment["speaker_score"] = item.get("speaker_score")
        segments.append(segment)

    return segments


HOTWORD_WEIGHTED_UNSUPPORTED_WARNED = False
HOTWORD_UNWEIGHTED_UNSUPPORTED_WARNED = False
PUNC_MODEL_WARNED = False
PUNC_GENERATE_WARNED = False


def generate_with_optional_hotword(model, payload, **kwargs):
    global HOTWORD_WEIGHTED_UNSUPPORTED_WARNED, HOTWORD_UNWEIGHTED_UNSUPPORTED_WARNED
    weighted_hotword = str(payload.get("hotword") or "").strip()
    unweighted_hotword = str(payload.get("hotword_unweighted") or "").strip()
    if not weighted_hotword and not unweighted_hotword:
        return model.generate(**kwargs)

    if weighted_hotword:
        try:
            return model.generate(**kwargs, hotword=weighted_hotword)
        except Exception as exc:
            if not HOTWORD_WEIGHTED_UNSUPPORTED_WARNED:
                print(
                    f"⚠️ SenseVoice/FunASR 当前版本不支持或无法使用 weighted hotword 参数，"
                    f"将降级为 unweighted hotword: {exc}",
                    file=sys.stderr,
                )
                HOTWORD_WEIGHTED_UNSUPPORTED_WARNED = True

    if unweighted_hotword:
        try:
            return model.generate(**kwargs, hotword=unweighted_hotword)
        except Exception as exc:
            if not HOTWORD_UNWEIGHTED_UNSUPPORTED_WARNED:
                print(
                    f"⚠️ SenseVoice/FunASR 当前版本不支持或无法使用 unweighted hotword 参数，"
                    f"已降级为无 hotword 转写并保留后处理 corrections: {exc}",
                    file=sys.stderr,
                )
                HOTWORD_UNWEIGHTED_UNSUPPORTED_WARNED = True

    return model.generate(**kwargs)


def load_punc_model(AutoModel, payload, device):
    global PUNC_MODEL_WARNED
    punc_model_name = resolve_cached_model_name(payload.get("punc_model"))
    if not punc_model_name:
        return None

    try:
        log_progress(f"加载标点模型: {punc_model_name}")
        return AutoModel(
            model=punc_model_name,
            device="cuda:0" if device == "cuda" else device,
            disable_update=True,
        )
    except Exception as exc:
        if not PUNC_MODEL_WARNED:
            print(
                f"⚠️ punc_model 加载失败，继续使用未恢复标点的原始文本: {exc}",
                file=sys.stderr,
            )
            PUNC_MODEL_WARNED = True
        return None


def restore_punctuation(punc_model, text):
    global PUNC_GENERATE_WARNED
    cleaned = clean_text(text)
    if not punc_model or not cleaned:
        return cleaned
    try:
        with suppress_model_output():
            result = punc_model.generate(input=cleaned)
        if isinstance(result, list) and result:
            item = result[0]
            if isinstance(item, dict):
                return clean_punctuation_text(item.get("text") or item.get("sentence") or cleaned)
        if isinstance(result, dict):
            return clean_punctuation_text(result.get("text") or result.get("sentence") or cleaned)
        return cleaned
    except Exception as exc:
        if not PUNC_GENERATE_WARNED:
            print(
                f"⚠️ punc_model 调用失败，继续使用原始文本: {exc}",
                file=sys.stderr,
            )
            PUNC_GENERATE_WARNED = True
        return cleaned


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
            f"ASR 转写块已限制为 {cap:g}s，避免 SenseVoice 长音频块漏字 "
            f"(requested max_vad_segment_s={requested:g}s)"
        )
    return min(requested, cap)


def speaker_label_from_cluster(label):
    if isinstance(label, dict):
        return label.get("label") or label.get("best_label") or "UNKNOWN", label.get("score")
    if isinstance(label, str):
        return label, None
    return f"SPEAKER_{int(label):02d}", None


def dominant_speaker_for_interval(start, end, speaker_timeline):
    if not speaker_timeline:
        return None, None

    scores = {}
    score_meta = {}
    for item in speaker_timeline:
        label = item.get("speaker")
        if not label:
            continue
        overlap = min(float(end), float(item["end"])) - max(float(start), float(item["start"]))
        if overlap <= 0:
            continue
        scores[label] = scores.get(label, 0.0) + overlap
        if item.get("speaker_score") and label not in score_meta:
            score_meta[label] = item.get("speaker_score")

    if not scores:
        return None, None

    label = max(scores.items(), key=lambda kv: kv[1])[0]
    return label, score_meta.get(label)


def has_timed_segments(raw_result):
    if isinstance(raw_result, dict):
        candidates = raw_result.get("sentence_info") or raw_result.get("segments") or raw_result.get("result")
        if isinstance(candidates, list):
            return any(has_timed_segments(item) for item in candidates)
        return any(key in raw_result for key in ("start", "end", "start_time", "end_time"))
    if isinstance(raw_result, list):
        return any(has_timed_segments(item) for item in raw_result)
    return False


def normalize_model_results_with_meta(results, meta, punc_model):
    timed_segments = []
    chunk_duration = max(0.0, float(meta["end"]) - float(meta["start"]))
    has_explicit_timing = has_timed_segments(results)

    if not has_explicit_timing:
        item = results[0] if results and isinstance(results, list) else {}
        text = restore_punctuation(punc_model, item.get("text", "") if isinstance(item, dict) else "")
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

    raw_segments = normalize_segments(results)
    for segment in raw_segments:
        start = float(segment.get("start", 0.0))
        end = float(segment.get("end", start + 0.1))
        # FunASR sentence_info inside chunk usually returns relative time.
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


def load_audio_16k_mono(audio_path):
    try:
        import soundfile as sf
        audio, sample_rate = sf.read(audio_path, dtype="float32", always_2d=False)
        if getattr(audio, "ndim", 1) > 1:
            audio = audio.mean(axis=1)
        if int(sample_rate) == 16000:
            return audio, 16000
        import librosa
        return librosa.resample(audio, orig_sr=int(sample_rate), target_sr=16000), 16000
    except Exception as exc:
        print(
            f"⚠️ soundfile 读取音频失败，降级使用 librosa.load: {exc}",
            file=sys.stderr,
            flush=True,
        )
        import librosa
        return librosa.load(audio_path, sr=16000, mono=True)


def build_speaker_reference_centroids(spk_model_obj, references, device):
    if not isinstance(references, list) or not references:
        return None

    import torch

    embeddings_by_speaker = {}
    max_chunks = 24
    for ref in references:
        if not isinstance(ref, dict):
            continue
        speaker = str(ref.get("speaker") or ref.get("label") or "").strip()
        audio_path = ref.get("audio_path") or ref.get("path")
        if not speaker or not audio_path or not os.path.exists(audio_path):
            continue
        log_progress(f"加载说话人参考音频: speaker={speaker}, path={audio_path}")
        audio, sample_rate = load_audio_16k_mono(audio_path)
        start_s = max(0.0, float(ref.get("start_s", 0) or 0))
        end_s = float(ref.get("end_s", 0) or 0)
        start_idx = min(len(audio), int(start_s * sample_rate))
        end_idx = min(len(audio), int(end_s * sample_rate)) if end_s > start_s else len(audio)
        audio = audio[start_idx:end_idx]
        chunk_s = float(ref.get("chunk_s", 8) or 8)
        max_chunks = int(ref.get("max_chunks", max_chunks) or max_chunks)
        chunk_len = max(1, int(chunk_s * sample_rate))
        chunks = []
        for idx in range(0, len(audio), chunk_len):
            chunk = audio[idx:idx + chunk_len]
            if len(chunk) < sample_rate:
                continue
            chunks.append(chunk)
            if len(chunks) >= max_chunks:
                break
        if not chunks:
            continue
        with suppress_model_output():
            results = spk_model_obj.generate(input=chunks, cache={}, is_final=True)
        valid_embeddings = [
            r["spk_embedding"]
            for r in results
            if r.get("spk_embedding") is not None and torch.isfinite(r["spk_embedding"]).all()
        ]
        if not valid_embeddings:
            continue
        embeddings_by_speaker.setdefault(speaker, []).extend(valid_embeddings)
        log_progress(f"参考说话人完成: speaker={speaker}, chunks={len(chunks)}")

    centroids = {}
    for speaker, speaker_embeddings in embeddings_by_speaker.items():
        embeddings = torch.cat(speaker_embeddings, dim=0)
        centroid = embeddings.mean(dim=0, keepdim=True)
        centroid = torch.nn.functional.normalize(centroid, dim=1)
        centroids[speaker] = centroid.to("cpu")
        log_progress(f"参考说话人聚合完成: speaker={speaker}, embeddings={len(speaker_embeddings)}")
    return centroids or None


def classify_speaker_embeddings(spk_results, references, threshold):
    if not references:
        return None

    import torch

    labels = []
    ref_items = list(references.items())
    for result in spk_results:
        embedding = torch.nn.functional.normalize(result["spk_embedding"].to("cpu"), dim=1)
        best_label = None
        best_score = -1.0
        for label, centroid in ref_items:
            score = float(torch.matmul(embedding, centroid.T).max().item())
            if score > best_score:
                best_label = label
                best_score = score
        labels.append({
            "label": best_label if best_score >= threshold else "UNKNOWN",
            "score": best_score,
            "best_label": best_label,
        })
    return labels


def smooth_speaker_timeline(speaker_timeline, fill_gap_s, max_unknown_duration_s):
    if not speaker_timeline:
        return speaker_timeline

    items = sorted(speaker_timeline, key=lambda item: (float(item.get("start", 0.0)), float(item.get("end", 0.0))))

    def nearest_known_left(index):
        for left in range(index - 1, -1, -1):
            if items[left].get("speaker") and items[left].get("speaker") != "UNKNOWN":
                return items[left]
        return None

    def nearest_known_right(index):
        for right in range(index + 1, len(items)):
            if items[right].get("speaker") and items[right].get("speaker") != "UNKNOWN":
                return items[right]
        return None

    for index, item in enumerate(items):
        if item.get("speaker") != "UNKNOWN":
            continue

        start = float(item.get("start", 0.0))
        end = float(item.get("end", start))
        duration = max(0.0, end - start)
        best_label = item.get("speaker_best_label")
        best_score = item.get("speaker_best_score")
        prev_item = nearest_known_left(index)
        next_item = nearest_known_right(index)

        if (
            prev_item
            and next_item
            and prev_item.get("speaker") == next_item.get("speaker")
        ):
            left_gap = max(0.0, start - float(prev_item.get("end", start)))
            right_gap = max(0.0, float(next_item.get("start", end)) - end)
            if duration <= max_unknown_duration_s and left_gap <= fill_gap_s and right_gap <= fill_gap_s:
                item["speaker"] = prev_item.get("speaker")
                item["speaker_score"] = max(
                    float(prev_item.get("speaker_score") or 0.0),
                    float(next_item.get("speaker_score") or 0.0)
                )
                item["speaker_smooth_reason"] = "between_same_speaker"
                continue

        if best_label and best_label != "UNKNOWN" and best_score is not None and duration <= max_unknown_duration_s:
            best_score = float(best_score)
            if prev_item and prev_item.get("speaker") == best_label:
                left_gap = max(0.0, start - float(prev_item.get("end", start)))
                if left_gap <= fill_gap_s and best_score >= 0.30:
                    item["speaker"] = best_label
                    item["speaker_score"] = best_score
                    item["speaker_smooth_reason"] = "left_neighbor_vote"
                    continue
            if next_item and next_item.get("speaker") == best_label:
                right_gap = max(0.0, float(next_item.get("start", end)) - end)
                if right_gap <= fill_gap_s and best_score >= 0.30:
                    item["speaker"] = best_label
                    item["speaker_score"] = best_score
                    item["speaker_smooth_reason"] = "right_neighbor_vote"
                    continue

    return items


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

    enable_speaker = bool(payload.get("enable_speaker", False))
    spk_model = payload.get("spk_model")
    if enable_speaker and not spk_model:
        fail("说话人分离已启用但 spk_model 未配置", "例如 spk_model=cam++")

    original_stdout = sys.stdout
    with contextlib.redirect_stdout(sys.stderr):
        model_name = payload.get("model", "iic/SenseVoiceSmall")
        resolved_model = resolve_cached_model_name(model_name)
        log_progress(f"准备主模型: {model_name}")
        if isinstance(resolved_model, str) and resolved_model == model_name and model_name.startswith("iic/"):
            try:
                log_progress(f"下载/解析模型缓存: {model_name}")
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
            if os.path.exists(model_py):
                model_kwargs["remote_code"] = model_py

        try:
            log_progress(f"加载主模型: {resolved_model}")
            with StageTimeout(payload.get("model_load_timeout_s", 180), "主模型加载"):
                model = AutoModel(**model_kwargs)
            log_progress("主模型加载完成")
        except Exception as exc:
            fail(
                "SenseVoice/FunASR 模型加载失败",
                f"{exc}\n可能是模型首次下载失败、网络不可用、模型名错误或 CUDA 环境异常。",
            )
        punc_model_obj = load_punc_model(AutoModel, payload, device)
        if punc_model_obj:
            log_progress("标点模型加载完成")

        try:
            vad_model_name = resolve_cached_model_name(payload.get("vad_model", "fsmn-vad"))
            log_progress(f"加载 VAD 模型: {vad_model_name}")
            with StageTimeout(payload.get("model_load_timeout_s", 180), "VAD 模型加载"):
                vad_model = AutoModel(
                    model=vad_model_name,
                    device="cuda:0" if device == "cuda" else device,
                    disable_update=True,
                )
            log_progress("VAD 模型加载完成，开始 VAD")
            with StageTimeout(payload.get("vad_timeout_s", 180), "VAD 处理"):
                with suppress_model_output():
                    vad_result = vad_model.generate(input=audio_path)
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
            if vad_segments:
                import torch
                log_progress("加载音频到内存")
                audio, sample_rate = load_audio_16k_mono(audio_path)
                log_progress(f"音频加载完成: duration={len(audio) / sample_rate:.1f}s, sample_rate={sample_rate}")
                batch_size_s = float(payload.get("batch_size_s", 60))
                batch_audio = []
                batch_meta = []
                batch_duration = 0.0
                speaker_timeline = []
                transcribed_segments = 0
                total_segments = len(vad_segments)

                if enable_speaker:
                    try:
                        resolved_spk_model = resolve_cached_model_name(spk_model)
                        log_progress(f"加载说话人模型: {resolved_spk_model}")
                        with StageTimeout(payload.get("model_load_timeout_s", 180), "说话人模型加载"):
                            spk_model_obj = AutoModel(
                                model=resolved_spk_model,
                                device="cuda:0" if device == "cuda" else device,
                                disable_update=True,
                            )
                        from funasr.models.campplus.cluster_backend import ClusterBackend

                        speaker_chunks = []
                        speaker_chunk_meta = []
                        speaker_vad_segments = split_vad_segments(
                            raw_vad_segments,
                            payload.get("speaker_max_segment_s", 8),
                        )
                        min_speaker_segment_s = float(payload.get("speaker_min_segment_s", 0.8) or 0.8)
                        log_progress("提取说话人 embedding")
                        for start_ms, end_ms in speaker_vad_segments:
                            start = max(0.0, float(start_ms) / 1000.0)
                            end = max(start, float(end_ms) / 1000.0)
                            if end - start < min_speaker_segment_s:
                                continue
                            start_idx = max(0, int(start * sample_rate))
                            end_idx = min(len(audio), int(end * sample_rate))
                            if end_idx <= start_idx:
                                continue
                            speaker_chunks.append(audio[start_idx:end_idx])
                            speaker_chunk_meta.append({"start": start, "end": end})

                        if speaker_chunks:
                            with StageTimeout(payload.get("speaker_timeout_s", 300), "说话人 embedding"):
                                with suppress_model_output():
                                    spk_results = spk_model_obj.generate(
                                        input=speaker_chunks,
                                        cache={},
                                        is_final=True,
                                    )
                            finite_spk_results = []
                            finite_speaker_chunk_meta = []
                            for result, meta in zip(spk_results, speaker_chunk_meta):
                                embedding = result.get("spk_embedding")
                                if embedding is None or not torch.isfinite(embedding).all():
                                    continue
                                finite_spk_results.append(result)
                                finite_speaker_chunk_meta.append(meta)
                            spk_results = finite_spk_results
                            speaker_chunk_meta = finite_speaker_chunk_meta
                            if not spk_results:
                                raise RuntimeError("说话人 embedding 全部无效")
                            reference_centroids = build_speaker_reference_centroids(
                                spk_model_obj,
                                payload.get("speaker_references"),
                                device,
                            )
                            labels = classify_speaker_embeddings(
                                spk_results,
                                reference_centroids,
                                float(payload.get("speaker_reference_threshold", 0.45)),
                            )
                            if labels is None:
                                embeddings = torch.cat([r["spk_embedding"] for r in spk_results], dim=0)
                                cluster = ClusterBackend(
                                    merge_thr=float(payload.get("speaker_merge_threshold", 0.78))
                                ).to("cuda:0" if device == "cuda" else device)
                                preset_spk_num = payload.get("preset_spk_num")
                                labels = cluster(
                                    embeddings.cpu(),
                                    oracle_num=int(preset_spk_num) if preset_spk_num else None,
                                )
                            for meta, label in zip(speaker_chunk_meta, labels):
                                speaker_label, speaker_score = speaker_label_from_cluster(label)
                                if isinstance(label, dict):
                                    best_label = label.get("best_label")
                                    best_score = label.get("score")
                                else:
                                    best_label = None
                                    best_score = None
                                speaker_timeline.append({
                                    "start": meta["start"],
                                    "end": meta["end"],
                                    "speaker": speaker_label,
                                    "speaker_score": speaker_score,
                                    "speaker_best_label": best_label,
                                    "speaker_best_score": best_score,
                                })
                            speaker_timeline = smooth_speaker_timeline(
                                speaker_timeline,
                                float(payload.get("speaker_unknown_fill_gap_s", 10.0) or 10.0),
                                float(payload.get("speaker_unknown_max_duration_s", 12.0) or 12.0),
                            )
                            unique_speakers = {item["speaker"] for item in speaker_timeline if item.get("speaker")}
                            log_progress(f"说话人聚类完成: labels={len(unique_speakers)}, chunks={len(speaker_chunks)}")
                    except Exception as exc:
                        fail(
                            "说话人分离失败",
                            f"{exc}\n可先关闭 enable_speaker，或检查 spk_model/preset_spk_num/CAM++ 依赖。",
                        )

                def flush_batch():
                    nonlocal batch_audio, batch_meta, batch_duration, raw_result, transcribed_segments
                    if not batch_audio:
                        return
                    for meta, chunk in zip(batch_meta, batch_audio):
                        transcribed_segments += 1
                        if transcribed_segments == 1 or transcribed_segments % 5 == 0 or transcribed_segments == total_segments:
                            pct = transcribed_segments / max(total_segments, 1) * 100
                            log_progress(f"转写进度: {pct:.1f}% ({transcribed_segments}/{total_segments})")
                        with StageTimeout(payload.get("segment_timeout_s", 90), "单段转写"):
                            with suppress_model_output():
                                results = generate_with_optional_hotword(
                                    model,
                                    payload,
                                    input=chunk,
                                    language=payload.get("language", "auto"),
                                    use_itn=bool(payload.get("use_itn", True)),
                                    batch_size_s=batch_size_s,
                                )
                        normalized_items = normalize_model_results_with_meta(results, meta, punc_model_obj)
                        for item in normalized_items:
                            if is_meaningless_asr_text(item.get("text", "")):
                                item["speaker"] = None
                                continue
                            speaker, speaker_score = dominant_speaker_for_interval(
                                item.get("start", meta["start"]),
                                item.get("end", meta["end"]),
                                speaker_timeline,
                            )
                            if speaker:
                                item["speaker"] = speaker
                            if speaker_score:
                                item["speaker_score"] = speaker_score
                        raw_result.extend(normalized_items)
                    batch_audio = []
                    batch_meta = []
                    batch_duration = 0.0

                log_progress("开始分段转写")
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
                    })
                    batch_duration += duration
                flush_batch()
                log_progress(f"分段转写完成: output_segments={len(raw_result)}")
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
