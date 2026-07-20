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

# protect_terms are forwarded from JS corrections.exclude_when (e.g. 碎机 -> [粉碎机]).
_JIEBA = None
_JIEBA_LOAD_ATTEMPTED = False


def normalize_backend_name(name):
    return BACKEND_ALIASES.get(str(name or "").strip().lower(), str(name or "").strip().lower())


def _load_jieba():
    global _JIEBA, _JIEBA_LOAD_ATTEMPTED
    if _JIEBA_LOAD_ATTEMPTED:
        return _JIEBA
    _JIEBA_LOAD_ATTEMPTED = True
    try:
        import jieba as jieba_mod
        _JIEBA = jieba_mod
    except Exception:
        _JIEBA = None
    return _JIEBA


def _normalize_string_list(raw):
    if isinstance(raw, str):
        return [part.strip() for part in raw.replace("\n", ",").split(",") if part.strip()]
    if isinstance(raw, (list, tuple)):
        return [str(item or "").strip() for item in raw if str(item or "").strip()]
    return []


def _resolve_phoneme_protect_terms(hotword_config=None):
    if not isinstance(hotword_config, dict):
        return []
    configured = _normalize_string_list(hotword_config.get("protect_terms"))
    seen = set()
    merged = []
    for term in sorted(configured, key=len, reverse=True):
        if not term or term in seen:
            continue
        seen.add(term)
        merged.append(term)
    return merged


def _resolve_phoneme_exclude_patterns(hotword_config=None):
    if not isinstance(hotword_config, dict):
        return []
    return _normalize_string_list(hotword_config.get("exclude_patterns"))


def _is_boundary_protect_enabled(hotword_config=None):
    if not isinstance(hotword_config, dict):
        return True
    return hotword_config.get("boundary_protect") is not False


def _mask_phoneme_protect_terms(text, protect_terms):
    masked = str(text or "")
    placeholders = []
    for index, term in enumerate(protect_terms or []):
        if not term or term not in masked:
            continue
        token = f"\uE000{index}\uE001"
        masked = masked.replace(term, token)
        placeholders.append((token, term))
    return masked, placeholders


def _restore_phoneme_protect_terms(text, placeholders):
    restored = str(text or "")
    for token, term in placeholders or []:
        restored = restored.replace(token, term)
    return restored


def _overlap(a_start, a_end, b_start, b_end):
    return a_start < b_end and b_start < a_end


def _is_protected_by_terms(text, start, end, protect_terms):
    source = str(text or "")
    for term in protect_terms or []:
        if not term:
            continue
        search_start = 0
        while search_start <= len(source):
            idx = source.find(term, search_start)
            if idx < 0:
                break
            if _overlap(start, end, idx, idx + len(term)):
                return True
            search_start = idx + 1
    return False


def _is_protected_by_patterns(text, start, end, exclude_patterns):
    source = str(text or "")
    for pattern_text in exclude_patterns or []:
        try:
            pattern = re.compile(pattern_text)
        except re.error:
            continue
        for match in pattern.finditer(source):
            if _overlap(start, end, match.start(), match.end()):
                return True
    return False


def _build_jieba_token_spans(text, protect_terms=None):
    jieba_mod = _load_jieba()
    source = str(text or "")
    if not jieba_mod or not source:
        return []
    for term in protect_terms or []:
        if term:
            try:
                jieba_mod.add_word(term, freq=100000)
            except Exception:
                pass
    tokens = []
    offset = 0
    for token in jieba_mod.cut(source, cut_all=False):
        token_text = str(token or "")
        if not token_text:
            continue
        idx = source.find(token_text, offset)
        if idx < 0:
            idx = offset
        start = idx
        end = idx + len(token_text)
        tokens.append((token_text, start, end))
        offset = end
    return tokens


def _is_protected_by_token_boundary(token_spans, start, end):
    for token_text, token_start, token_end in token_spans or []:
        if token_end <= start or token_start >= end:
            continue
        # Same rule as JS: match sits strictly inside a larger non-trivial token.
        if start >= token_start and end <= token_end and (start > token_start or end < token_end):
            if token_text and not re.fullmatch(r"[\s\W_]+", token_text):
                return True
    return False


def _correct_text_with_protections(pc, text, hotword_config=None):
    """Run PhonemeCorrector while honoring exclude_when / patterns / jieba boundaries."""
    from hotword.algo_phoneme import get_phoneme_info
    from hotword.hot_phoneme import CorrectionResult

    source = str(text or "")
    if not source or not getattr(pc, "hotwords", None):
        return CorrectionResult(text=source, matches=[], similars=[])

    protect_terms = _resolve_phoneme_protect_terms(hotword_config)
    exclude_patterns = _resolve_phoneme_exclude_patterns(hotword_config)
    boundary_protect = _is_boundary_protect_enabled(hotword_config)

    # Explicit whitelist compounds are masked first so phoneme search cannot see them.
    masked_text, placeholders = _mask_phoneme_protect_terms(source, protect_terms)
    working_text = masked_text

    input_phonemes = get_phoneme_info(working_text)
    if not input_phonemes:
        return CorrectionResult(text=source, matches=[], similars=[])

    with pc._lock:
        fast_results = pc.fast_rag.search(input_phonemes, top_k=0)
        input_processed = [p.info for p in input_phonemes]
        matches, similars = pc._find_matches(working_text, fast_results, input_processed)

    token_spans = _build_jieba_token_spans(working_text, protect_terms) if boundary_protect else []
    filtered_matches = []
    for match in matches:
        if _is_protected_by_terms(working_text, match.start, match.end, protect_terms):
            continue
        if _is_protected_by_patterns(working_text, match.start, match.end, exclude_patterns):
            continue
        if boundary_protect and _is_protected_by_token_boundary(token_spans, match.start, match.end):
            continue
        filtered_matches.append(match)

    new_text, final_hw_info, _all_hw_info = pc._resolve_and_replace(working_text, filtered_matches)
    restored = _restore_phoneme_protect_terms(new_text, placeholders)
    return CorrectionResult(text=restored, matches=final_hw_info, similars=similars)


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

        hotword_config = payload.get("phoneme_correction", {}) or {}
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
            result = _correct_text_with_protections(pc, text, hotword_config)
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
