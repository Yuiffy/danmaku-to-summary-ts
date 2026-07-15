import os
import re
import sys

from sensevoice_runtime import log_progress, suppress_model_output


TAG_RE = re.compile(r"<\|[^|]+?\|>")
MODELSCOPE_IIC_DIR = os.path.join(os.path.expanduser("~"), ".cache", "modelscope", "hub", "models", "iic")
MODEL_ALIASES = {
    "iic/SenseVoiceSmall": "SenseVoiceSmall",
    "SenseVoiceSmall": "SenseVoiceSmall",
    "fsmn-vad": "speech_fsmn_vad_zh-cn-16k-common-pytorch",
    "ct-punc": "punc_ct-transformer_cn-en-common-vocab471067-large",
    "cam++": "speech_campplus_sv_zh-cn_16k-common",
}

BACKEND_ALIASES = {
    "fun-asr-nano": "fun_asr_nano",
    "fun_asr_nano": "fun_asr_nano",
    "fun-asr-nano-vllm": "fun_asr_nano_vllm",
    "fun_asr_nano-vllm": "fun_asr_nano_vllm",
    "fun_asr_nano_vllm": "fun_asr_nano_vllm",
    "sensevoice": "sensevoice",
    "paraformer": "paraformer",
    "paraformer-zh": "paraformer",
}

HOTWORD_WEIGHTED_UNSUPPORTED_WARNED = False
HOTWORD_UNWEIGHTED_UNSUPPORTED_WARNED = False
PUNC_MODEL_WARNED = False
PUNC_GENERATE_WARNED = False


def normalize_backend_name(name):
    return BACKEND_ALIASES.get(str(name or "").strip().lower(), str(name or "").strip().lower())


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

        start = float(start_raw or 0)
        end = float(end_raw or 0)
        if item.get("time_unit") != "seconds" and (start > 1000 or end > 1000):
            start /= 1000.0
            end /= 1000.0
        if end <= start:
            end = start + 0.1

        speaker = item.get("spk")
        if speaker is None:
            speaker = item.get("speaker")
        segment = {"start": start, "end": end, "text": text}
        if speaker is not None:
            segment["speaker"] = str(speaker)
        if item.get("speaker_score"):
            segment["speaker_score"] = item.get("speaker_score")
        segments.append(segment)

    return segments


def generate_with_optional_hotword(model, payload, backend_name, **kwargs):
    global HOTWORD_WEIGHTED_UNSUPPORTED_WARNED, HOTWORD_UNWEIGHTED_UNSUPPORTED_WARNED
    if backend_name == "fun_asr_nano":
        import torch

        input_data = kwargs.get("input")
        if not isinstance(input_data, (str, torch.Tensor)):
            kwargs["input"] = torch.as_tensor(input_data, dtype=torch.float32)
        hotwords = payload.get("hotwords") or []
        if isinstance(hotwords, list) and hotwords:
            try:
                return model.generate(**kwargs, hotwords=hotwords)
            except Exception as exc:
                print(
                    f"⚠️ Fun-ASR-Nano hotwords 参数调用失败，降级为无 hotwords 转写: {exc}",
                    file=sys.stderr,
                )
        return model.generate(**kwargs)

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
                    f"⚠️ ASR 当前版本不支持或无法使用 weighted hotword 参数，"
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
                    f"⚠️ ASR 当前版本不支持或无法使用 unweighted hotword 参数，"
                    f"已降级为无 hotword 转写并保留后处理 corrections: {exc}",
                    file=sys.stderr,
                )
                HOTWORD_UNWEIGHTED_UNSUPPORTED_WARNED = True

    return model.generate(**kwargs)


def load_punc_model(AutoModel, payload, device, gpu_throttle=None):
    global PUNC_MODEL_WARNED
    punc_model_name = resolve_cached_model_name(payload.get("punc_model"))
    if not punc_model_name:
        return None

    try:
        log_progress(f"加载标点模型: {punc_model_name}")
        if gpu_throttle:
            gpu_throttle.wait_if_busy("标点模型加载")
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


def _apply_hotword_correction(output, payload):
    """Apply asr-hotword PhonemeCorrector to output segments."""
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.normpath(os.path.join(script_dir, "..", "..", ".."))
        hotword_candidates = [
            os.path.join(project_root, "tmp", "asr-hotword"),
            os.path.join(project_root, "asr-hotword"),
        ]
        hotword_path = None
        for candidate in hotword_candidates:
            candidate = os.path.normpath(candidate)
            if os.path.isfile(os.path.join(candidate, "hotword", "__init__.py")):
                hotword_path = candidate
                break
        if not hotword_path:
            raise ImportError(
                f"asr-hotword 未找到，搜索路径: {hotword_candidates}。"
                f"请 clone asr-hotword 到 tmp/asr-hotword 目录。"
            )
        sys.path.insert(0, hotword_path)
        from hotword import PhonemeCorrector

        hotword_config = payload.get("phoneme_correction", {})
        threshold = float(hotword_config.get("threshold", 0.85) or 0.85)
        pc = PhonemeCorrector(threshold=threshold)

        hotword_text = hotword_config.get("hotwords", "")
        if hotword_text:
            pc.update_hotwords(hotword_text)

        corrections_count = 0
        for seg in output.get("segments", []):
            text = seg.get("text", "")
            if not text or len(text.strip()) <= 1:
                continue
            result = pc.correct(text)
            if result.text != text:
                corrections_count += 1
                seg["text"] = result.text
                seg["phoneme_corrections"] = [
                    {"from": match[0], "to": match[1], "score": match[2]}
                    for match in result.matches
                ]

        if corrections_count > 0:
            log_progress(f"asr-hotword 纠正: {corrections_count}/{len(output.get('segments', []))} 段")
    except Exception as exc:
        print(f"⚠️ asr-hotword 纠正失败，继续使用原始文本: {exc}", file=sys.stderr)
