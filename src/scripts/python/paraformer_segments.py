"""Pure Paraformer timestamp and subtitle alignment helpers."""
import re
import unicodedata
from sensevoice_text import extract_sensevoice_metadata, normalize_segments, restore_punctuation

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


def _normalize_paraformer_spacing(text):
    # Chinese token separators are disposable; English word boundaries are not.
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return re.sub(r"(?<=[\u3400-\u9fff]) (?=[\u3400-\u9fff])", "", text)


def _paraformer_text_units(text):
    units = []
    index = 0
    text = _normalize_paraformer_spacing(text)
    while index < len(text):
        char = text[index]
        if char.isspace():
            units.append({"text": " ", "timed": False})
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

    raw_text = _normalize_paraformer_spacing(item.get("text", ""))
    text = restore_punctuation(punc_model, raw_text)
    if not text:
        return []

    # Reuse word-aware alignment: spaces/punctuation consume no timestamps,
    # while an English word (including contractions) consumes exactly one.
    segments = paraformer_full_text_to_segments({
        "text": text, "timestamp": item.get("timestamp"),
    }, max_subtitle_chars)
    if segments:
        offset = float(meta["start"])
        for segment in segments:
            segment["start"] = round(offset + segment["start"], 3)
            segment["end"] = round(offset + segment["end"], 3)
            segment["speaker"] = meta.get("speaker")
            segment["speaker_score"] = meta.get("speaker_score")
        return segments

    # Missing or mismatched timestamps retain the complete chunk text.
    return [{
        "start": meta["start"], "end": meta["end"], "text": text,
        "time_unit": "seconds", "speaker": meta.get("speaker"),
        "speaker_score": meta.get("speaker_score"),
    }]


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
