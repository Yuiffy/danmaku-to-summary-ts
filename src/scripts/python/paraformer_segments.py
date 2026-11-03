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
ASCII_FORMAT_PUNCTUATION_RE = re.compile(r"['’`\-‐‑‒–—−]")


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


def _alignment_token_key(text):
    """Normalize harmless display formatting before comparing ASR tokens."""
    value = unicodedata.normalize("NFKC", str(text or "")).casefold()
    if ASCII_WORD_RE.fullmatch(value):
        value = ASCII_FORMAT_PUNCTUATION_RE.sub("", value)
    return value


def _assign_display_timestamps(raw_text, display_text, timestamps):
    """Align punctuation-restored display units to raw character timestamps.

    FunASR timestamps belong to the recognizer hypothesis, while ct-punc may
    insert punctuation, normalize spaces, or change ASCII word formatting.
    Those edits are safe to preserve as long as the lexical token sequence is
    unchanged. A real word substitution returns a diagnostic reason so the
    caller can use sentence/chunk timing instead of claiming precision.
    """
    raw_units = _paraformer_text_units(raw_text)
    raw_timed = [unit for unit in raw_units if unit["timed"]]
    if not raw_timed:
        return [], "no_timed_tokens"
    if not isinstance(timestamps, list) or len(raw_timed) != len(timestamps):
        return None, "timestamp_count_mismatch"

    for unit, timestamp in zip(raw_timed, timestamps):
        try:
            start_ms, end_ms = timestamp
            start = float(start_ms) / 1000.0
            end = float(end_ms) / 1000.0
        except (TypeError, ValueError):
            return None, "invalid_timestamp"
        if not (start >= 0 and end >= start):
            return None, "invalid_timestamp"
        unit["start"], unit["end"] = start, end

    display_units = _paraformer_text_units(display_text)
    display_timed = [unit for unit in display_units if unit["timed"]]
    if not display_timed:
        return None, "display_has_no_timed_tokens"

    raw_keys = [_alignment_token_key(unit["text"]) for unit in raw_timed]
    display_keys = [_alignment_token_key(unit["text"]) for unit in display_timed]

    def concatenate(keys, start, count):
        return "".join(keys[start:start + count])

    raw_index = 0
    display_index = 0
    while display_index < len(display_timed):
        if raw_index >= len(raw_timed):
            return None, "token_count_mismatch"

        display_key = display_keys[display_index]
        raw_key = raw_keys[raw_index]
        if display_key == raw_key:
            display_timed[display_index]["start"] = raw_timed[raw_index]["start"]
            display_timed[display_index]["end"] = raw_timed[raw_index]["end"]
            raw_index += 1
            display_index += 1
            continue

        # Allow tokenization/spacing changes such as "RTX 5090" -> "RTX5090"
        # and "Wi-Fi" -> "WiFi", while retaining the whole consumed span.
        matched = False
        for raw_count in range(2, min(4, len(raw_timed) - raw_index) + 1):
            if display_key != concatenate(raw_keys, raw_index, raw_count):
                continue
            display_timed[display_index]["start"] = raw_timed[raw_index]["start"]
            display_timed[display_index]["end"] = raw_timed[raw_index + raw_count - 1]["end"]
            raw_index += raw_count
            display_index += 1
            matched = True
            break
        if matched:
            continue

        for display_count in range(2, min(4, len(display_timed) - display_index) + 1):
            if raw_key != concatenate(display_keys, display_index, display_count):
                continue
            start = raw_timed[raw_index]["start"]
            end = raw_timed[raw_index]["end"]
            span = max(0.0, end - start)
            for offset in range(display_count):
                part_start = start + span * offset / display_count
                part_end = start + span * (offset + 1) / display_count
                display_timed[display_index + offset]["start"] = part_start
                display_timed[display_index + offset]["end"] = part_end
            raw_index += 1
            display_index += display_count
            matched = True
            break
        if matched:
            continue

        return None, "token_mismatch"

    if raw_index != len(raw_timed):
        return None, "token_count_mismatch"
    return display_units, None


SUBTITLE_MAX_DURATION = 6.5
SUBTITLE_MIN_DURATION = 0.9
SUBTITLE_MIN_GAP = 0.08
SUBTITLE_PAD_HEAD = 0.03
SUBTITLE_PAD_TAIL = 0.12
# Speech stopping is not a cue to blank the screen. Caption practice holds the
# line through the pause that follows, so the eye can finish reading it.
SUBTITLE_TAIL_HOLD = 1.2
SUBTITLE_SILENCE_GAP = 0.90
SUBTITLE_UNPROBED_SILENCE_GAP = 1.5
SUBTITLE_TOKEN_BREAK_PENALTY = 5.0
SUBTITLE_CUT_BASE_COST = 1.0
SUBTITLE_CLAUSE_DISCOUNT = 0.8
SUBTITLE_CROSSED_STOP_PENALTY = 3.0

_JIEBA_MODULE = None


def _jieba_cut(text):
    """Split Chinese text into words; None when jieba is unavailable."""
    global _JIEBA_MODULE
    if _JIEBA_MODULE is None:
        try:
            import jieba
        except Exception:
            _JIEBA_MODULE = False
        else:
            _JIEBA_MODULE = jieba
    if not _JIEBA_MODULE:
        return None
    return list(_JIEBA_MODULE.cut(text, HMM=True))


def _display_width(text):
    """Subtitle width in full-width cells; ASCII takes half a cell."""
    return sum(
        0.5 if unicodedata.east_asian_width(char) in ("Na", "H") else 1.0
        for char in text
    )


def _collect_subtitle_items(units):
    """Collapse alignment units into timed characters carrying their punctuation.

    Punctuation and spaces hold no timestamp, so they ride on the preceding
    character. That keeps the recognizer's punctuation attached to the word it
    follows while leaving every subtitle boundary anchored on real speech.
    """
    items = []
    for unit in units:
        if not unit["timed"]:
            if items:
                items[-1]["text"] += unit["text"]
            continue
        items.append({
            "text": unit["text"],
            "start": unit["start"],
            "end": unit["end"],
            "boundary": False,
        })
    return items


def _is_latin_item(item):
    """True when an item is a single recognizer token made only of Latin script."""
    visible = [
        char for char in item["text"]
        if not char.isspace() and not unicodedata.category(char).startswith("P")
    ]
    return bool(visible) and all(unicodedata.east_asian_width(char) in ("Na", "H") for char in visible)


def _assign_word_boundaries(items):
    """Mark the characters that end a word so no cut lands inside one."""
    if not items:
        return

    # A recognizer token that is already a whole Latin word is atomic, and must
    # stay out of the Chinese segmentation text: gluing "Iwanttomakeacall"
    # together makes jieba invent boundaries inside those words.
    for item in items:
        if _is_latin_item(item):
            item["boundary"] = True

    run = []

    def close_run():
        if not run:
            return
        characters = [items[index]["text"][0] for index in run]
        tokens = _jieba_cut("".join(characters))
        if tokens is not None and "".join(tokens) == "".join(characters):
            position = 0
            for token in tokens:
                position += len(token)
                if 0 < position <= len(run):
                    items[run[position - 1]]["boundary"] = True
        else:
            for index in run:
                tail = items[index]["text"][-1:]
                if tail in SENTENCE_ENDS or tail in CLAUSE_ENDS:
                    items[index]["boundary"] = True
        run.clear()

    for index, item in enumerate(items):
        if _is_latin_item(item):
            close_run()
            continue
        run.append(index)
    close_run()
    items[-1]["boundary"] = True


def _gap_after(items, index):
    if index + 1 >= len(items):
        return 0.0
    return max(0.0, items[index + 1]["start"] - items[index]["end"])


def _silence_after(items, index, speech_probe, gap):
    """Length of the verified-silent break after ``index``, else 0.

    A character gap is only trusted when the acoustic envelope agrees nobody is
    talking there. Unrecognized speech leaves phantom gaps in the character
    timestamps, and cutting on those silently drops audible dialogue.
    """
    unprobed = gap if gap >= SUBTITLE_UNPROBED_SILENCE_GAP else 0.0
    if speech_probe is None:
        return unprobed
    start = items[index]["end"] + 0.06
    end = items[index + 1]["start"] - 0.06
    if end <= start:
        return gap
    try:
        voiced = float(speech_probe(start, end))
    except Exception:
        return unprobed
    if voiced < 0.70:
        return gap
    return 0.0


def _collect_silence_breaks(items, speech_probe):
    """Probe every wide character gap once, before the planner revisits it."""
    breaks = [0.0] * len(items)
    for index in range(len(items) - 1):
        gap = _gap_after(items, index)
        if gap >= SUBTITLE_SILENCE_GAP:
            breaks[index] = _silence_after(items, index, speech_probe, gap)
    return breaks


def _subtitle_cut_cost(items, index, last, silence, width, max_chars):
    """Cost of ending a subtitle after ``index``; lower means more natural.

    Cutting is never free: a flat base charge means a cue only breaks when the
    audio stops, a sentence ends, or the width budget forces it.

    The comma discount fades out on short cues. Otherwise "你好，" alone would
    qualify as a cue of its own just for ending in punctuation.
    """
    if index == last:
        return 0.0
    tail = items[index]["text"][-1:]
    cost = SUBTITLE_CUT_BASE_COST
    if silence > 0:
        cost -= 3.5 + min(1.5, silence * 0.3)
    elif _gap_after(items, index) >= 0.35:
        cost -= 0.5
    if tail in SENTENCE_ENDS:
        # A finished sentence is its own boundary, so it earns the strongest
        # discount and is exempt from the dangling-tail surcharge.
        cost -= 2.0
    else:
        if tail in CLAUSE_ENDS:
            cost -= SUBTITLE_CLAUSE_DISCOUNT * min(1.0, width / max(1.0, max_chars * 0.5))
        if items[index]["boundary"]:
            cost -= 0.5
        else:
            cost += SUBTITLE_TOKEN_BREAK_PENALTY
        if last - index <= 2:
            cost += 2.5
    return cost


def _plan_subtitle_spans(items, max_chars, speech_probe):
    """Cheapest way to cover one sentence with readable, speech-tight cues."""
    count = len(items)
    if count == 0:
        return []
    breaks = _collect_silence_breaks(items, speech_probe)
    # Width, not character count: a Latin word must not consume the budget of
    # its full-width equivalent or English lines get shredded.
    lengths = [0.0] * (count + 1)
    stops = [0] * (count + 1)
    for index, item in enumerate(items):
        lengths[index + 1] = lengths[index] + _display_width(item["text"])
        stops[index + 1] = stops[index] + (1 if item["text"][-1:] in SENTENCE_ENDS else 0)
    infinity = float("inf")
    best = [infinity] * (count + 1)
    previous = [-1] * (count + 1)
    best[0] = 0.0
    span = max(1, int(max_chars))
    for start in range(count):
        if best[start] == infinity:
            continue
        for end in range(start + 1, min(count, start + span) + 1):
            if items[end - 1]["end"] - items[start]["start"] > SUBTITLE_MAX_DURATION and end - start > 2:
                break
            if lengths[end] - lengths[start] > max_chars:
                break
            if end < count and end - start < 2 and breaks[end - 1] <= 0:
                continue
            cost = _subtitle_cut_cost(
                items, end - 1, count - 1, breaks[end - 1],
                lengths[end] - lengths[start], max_chars,
            )
            # Swallowing a full stop inside a cue hides a natural break.
            cost += SUBTITLE_CROSSED_STOP_PENALTY * (stops[end - 1] - stops[start])
            if end < count and end - start == 1:
                cost += 1.2
            cost += 0.04 * max(0, 8 - (end - start))
            if best[start] + cost < best[end]:
                best[end] = best[start] + cost
                previous[end] = start
    if best[count] == infinity:
        return [(0, count)]
    spans = []
    cursor = count
    while cursor > 0:
        spans.append((previous[cursor], cursor))
        cursor = previous[cursor]
    return spans[::-1]


def _settle_subtitle_timing(cues, max_chars, tail_hold=SUBTITLE_TAIL_HOLD):
    """Merge fragments, hold a readable floor, and keep cues from overlapping."""
    merged = []
    for cue in cues:
        previous = merged[-1] if merged else None
        if (
            previous
            and (cue["end"] - cue["start"] < 0.55 or len(cue["text"]) <= 1)
            and cue["start"] - previous["end"] <= 0.40
            and _display_width(previous["text"] + cue["text"]) <= max_chars
            and cue["end"] - previous["start"] <= SUBTITLE_MAX_DURATION
        ):
            previous["text"] += cue["text"]
            previous["end"] = cue["end"]
            continue
        merged.append(cue)

    # A cue too short to read borrows the silence on either side, never the next
    # line's speech.
    for index, cue in enumerate(merged):
        if cue["end"] - cue["start"] >= SUBTITLE_MIN_DURATION:
            continue
        needed = SUBTITLE_MIN_DURATION - (cue["end"] - cue["start"])
        floor = merged[index - 1]["end"] + SUBTITLE_MIN_GAP if index else 0.0
        borrowed = min(needed * 0.6, max(0.0, cue["start"] - floor))
        cue["start"] = round(cue["start"] - borrowed, 3)
        needed -= borrowed
        if needed > 0:
            ceiling = (
                merged[index + 1]["start"] - SUBTITLE_MIN_GAP
                if index + 1 < len(merged)
                else cue["end"] + needed
            )
            cue["end"] = round(min(cue["end"] + needed, max(cue["end"], ceiling)), 3)

    # A cue that vanishes on the last syllable reads as a flicker. Hold it into
    # the following pause, capped by the next line's lead-in and by the readable
    # duration limit, so the hold never overlaps a cue or sprawls over silence.
    if tail_hold > 0:
        for index, cue in enumerate(merged):
            ceiling = cue["start"] + SUBTITLE_MAX_DURATION
            if index + 1 < len(merged):
                ceiling = min(ceiling, merged[index + 1]["start"] - SUBTITLE_MIN_GAP)
            cue["end"] = round(
                min(cue["end"] + tail_hold, max(cue["end"], ceiling)), 3
            )

    for current, following in zip(merged, merged[1:]):
        if current["end"] > following["start"] - SUBTITLE_MIN_GAP:
            current["end"] = round(
                min(current["end"], max(current["start"] + 0.3, following["start"] - SUBTITLE_MIN_GAP)),
                3,
            )
        if current["end"] < current["start"] + 0.2:
            current["end"] = round(current["start"] + 0.2, 3)
    return merged


def paraformer_full_text_alignment(
    result,
    max_subtitle_chars=16,
    speech_probe=None,
    tail_hold=SUBTITLE_TAIL_HOLD,
):
    """Return subtitle segments plus the reason precision alignment failed.

    ``speech_probe(start, end)`` optionally reports the voiced fraction of the
    audio between two seconds so silent gaps can be confirmed before a cue is
    split there.

    ``tail_hold`` keeps a cue on screen for that many seconds after the last
    spoken syllable. Callers that need raw speech spans (speaker segmentation)
    pass ``0``.
    """
    if not isinstance(result, dict):
        return [], "invalid_result"
    raw_text = result.get("raw_text", result.get("text", ""))
    display_text = result.get("display_text", result.get("text", ""))
    timestamps = result.get("timestamp") if isinstance(result, dict) else None
    if not raw_text or not display_text or not isinstance(timestamps, list) or not timestamps:
        return [], "missing_text_or_timestamps"

    units, reason = _assign_display_timestamps(raw_text, display_text, timestamps)
    if units is None:
        return [], reason

    items = _collect_subtitle_items(units)
    if not items:
        return [], None
    _assign_word_boundaries(items)

    max_chars = max(4, int(max_subtitle_chars or 16))
    spans = _plan_subtitle_spans(items, max_chars, speech_probe)
    cues = []
    for start, end in spans:
        piece = items[start:end]
        text = "".join(item["text"] for item in piece).strip()
        if not text:
            continue
        cues.append({
            "start": max(0.0, round(piece[0]["start"] - SUBTITLE_PAD_HEAD, 3)),
            "end": round(piece[-1]["end"] + SUBTITLE_PAD_TAIL, 3),
            "text": text,
        })

    segments = [
        {
            "start": cue["start"],
            "end": round(max(cue["end"], cue["start"] + 0.1), 3),
            "text": cue["text"],
            "time_unit": "seconds",
        }
        for cue in _settle_subtitle_timing(cues, max_chars, tail_hold)
    ]
    return segments, None


def paraformer_full_text_to_segments(
    result,
    max_subtitle_chars=16,
    speech_probe=None,
    tail_hold=SUBTITLE_TAIL_HOLD,
):
    segments, _reason = paraformer_full_text_alignment(
        result, max_subtitle_chars, speech_probe, tail_hold
    )
    return segments


def make_speech_probe(audio, sample_rate):
    """Build a voiced-fraction probe from mono float audio already in memory.

    The envelope is computed once in fixed-size blocks so a multi-hour stream
    costs a few megabytes instead of one frame matrix per query.
    """
    import numpy as np

    samples = np.asarray(audio, dtype="float32")
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    rate = int(sample_rate or 16000)
    frame = max(1, int(rate * 0.02))
    hop = max(1, int(rate * 0.01))
    count = 1 + max(0, (samples.size - frame) // hop)
    if count < 4:
        return lambda start, end: 1.0

    level = np.empty(count, dtype="float32")
    block = 20000
    offsets = np.arange(frame)
    for begin in range(0, count, block):
        end_frame = min(count, begin + block)
        indices = offsets[None, :] + hop * np.arange(begin, end_frame)[:, None]
        chunk = samples[indices]
        level[begin:end_frame] = 20.0 * np.log10(
            np.maximum(np.sqrt(np.mean(chunk * chunk, axis=1) + 1e-12), 1e-8)
        )

    # A slow local baseline keeps music beds from masking real pauses; the
    # running mean is a cheap stand-in for a median filter.
    window = max(3, int(5.0 * rate / hop))
    cumulative = np.concatenate(([0.0], np.cumsum(level, dtype="float64")))
    padded = np.pad(cumulative, (window // 2, window - 1 - window // 2), mode="edge")
    baseline = (padded[window:] - padded[:-window]) / window
    threshold = np.maximum(float(np.percentile(level, 10)) + 9.0, baseline + 4.0)
    voiced = level > threshold

    def probe(start, end):
        if end <= start:
            return 0.0
        first = max(0, int(start * rate / hop))
        last = min(count, max(first + 1, int(end * rate / hop)))
        if last <= first:
            return 1.0
        return float(voiced[first:last].mean())

    return probe


def update_timing_diagnostics(diagnostics, source, reason=None):
    """Record timing sources without changing the stable ASR segment schema."""
    if not isinstance(diagnostics, dict):
        return
    sources = diagnostics.setdefault("sources", {})
    sources[source] = int(sources.get(source, 0)) + 1
    if reason:
        reasons = diagnostics.setdefault("fallback_reasons", {})
        reasons[reason] = int(reasons.get(reason, 0)) + 1


def select_paraformer_speaker_intervals(
    result,
    sentence_info,
    vad_intervals=None,
    max_subtitle_chars=16,
    speech_probe=None,
):
    """Use VAD spans with the same timestamped segments emitted as subtitles."""
    precise_segments = paraformer_full_text_to_segments(
        result,
        max_subtitle_chars=max_subtitle_chars,
        speech_probe=speech_probe,
        # Speaker segmentation trusts speech spans, not display timing: a held
        # cue would smear 1.2s of silence into the next speaker's interval.
        tail_hold=0.0,
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


def paraformer_timestamp_to_sentences(results, meta, punc_model, max_subtitle_chars=16, speech_probe=None):
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
    diagnostics = meta.get("timing_diagnostics") if isinstance(meta, dict) else None
    segments, alignment_reason = paraformer_full_text_alignment({
        "raw_text": raw_text,
        "display_text": text,
        "timestamp": item.get("timestamp"),
    }, max_subtitle_chars, speech_probe)
    if segments:
        update_timing_diagnostics(diagnostics, "char_timestamp")
        offset = float(meta["start"])
        for segment in segments:
            segment["start"] = round(offset + segment["start"], 3)
            segment["end"] = round(offset + segment["end"], 3)
            segment["speaker"] = meta.get("speaker")
            segment["speaker_score"] = meta.get("speaker_score")
        return segments

    update_timing_diagnostics(diagnostics, "chunk_fallback", alignment_reason)
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
