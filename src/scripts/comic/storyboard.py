"""Parse narrative beats and visual-evidence requests without media IO."""
import json
import re
from typing import Any, Dict, Optional


def _coerce_timestamp_seconds(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if float(value) >= 0 else None
    text = str(value or "").strip()
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        return float(text)
    match = re.fullmatch(r"(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)", text)
    if match:
        hours = int(match.group(1) or 0)
        return hours * 3600 + int(match.group(2)) * 60 + float(match.group(3))
    return None


def _extract_comic_json_objects(comic_text: str) -> list[dict]:
    """Return structured records from JSON arrays, JSON Lines, or adjacent JSON values."""
    text = re.sub(r"```(?:jsonl?)?\s*", "", comic_text or "", flags=re.IGNORECASE)
    candidates: list[Any] = []

    def append_payload(payload: Any) -> None:
        if isinstance(payload, dict):
            nested = []
            for key in ("shots", "beats", "references"):
                value = payload.get(key)
                if isinstance(value, list):
                    nested.extend(value)
            if nested:
                for item in nested:
                    append_payload(item)
            else:
                candidates.append(payload)
        elif isinstance(payload, list):
            for item in payload:
                append_payload(item)

    decoder = json.JSONDecoder()
    cursor = 0
    while cursor < len(text):
        while cursor < len(text) and (text[cursor].isspace() or text[cursor] in ",;"):
            cursor += 1
        if cursor >= len(text):
            break
        if text[cursor] not in "[{":
            next_value = re.search(r"[\[{]", text[cursor + 1:])
            if not next_value:
                break
            cursor += next_value.start() + 1
        try:
            payload, end = decoder.raw_decode(text, cursor)
        except json.JSONDecodeError:
            cursor += 1
            continue
        append_payload(payload)
        cursor = end

    return [item for item in candidates if isinstance(item, dict)]


def _clean_prompt_text(value: Any, default: str = "") -> str:
    return re.sub(r"\s+", " ", str(value or default)).strip()


def extract_storyboard_shots(comic_text: str, max_shots: int = 3) -> list[dict]:
    """Parse narrative beats while excluding independent visual-evidence records."""
    candidates = _extract_comic_json_objects(comic_text)

    normalized = []
    seen_timestamps = set()
    for item in candidates:
        if str(item.get("kind") or "").strip().lower() == "reference":
            continue
        timestamp = _coerce_timestamp_seconds(item.get("timestampSeconds"))
        scene = _clean_prompt_text(item.get("scene"))
        if timestamp is None or not scene:
            continue
        timestamp_key = round(timestamp, 1)
        if timestamp_key in seen_timestamps:
            continue
        seen_timestamps.add(timestamp_key)
        normalized.append({
            "timestampSeconds": timestamp,
            "scene": scene,
            "visualIntent": _clean_prompt_text(item.get("visualIntent"), "核对构图、动作和情绪"),
            "referenceUsage": _clean_prompt_text(
                item.get("referenceUsage"), "核对该时刻的场景、界面和道具"
            ),
        })
        if len(normalized) >= max(1, int(max_shots)):
            break
    return normalized


def _normalize_reference_timestamps(item: Dict[str, Any], max_timestamps: int = 4) -> list[float]:
    """Accept the new timestamp list while remaining compatible with older scripts."""
    raw_values = item.get("timestampsSeconds")
    if not isinstance(raw_values, list):
        raw_values = item.get("timestamps")
    if not isinstance(raw_values, list):
        raw_values = [item.get("timestampSeconds")]

    normalized = []
    seen = set()
    for raw_value in raw_values:
        timestamp = _coerce_timestamp_seconds(raw_value)
        if timestamp is None or timestamp < 0:
            continue
        timestamp_key = round(timestamp, 1)
        if timestamp_key in seen:
            continue
        seen.add(timestamp_key)
        normalized.append(timestamp)
        if len(normalized) >= max(1, int(max_timestamps)):
            break
    return normalized


def extract_reference_requests(comic_text: str, max_requests: int = 4) -> list[dict]:
    """Parse script-planned screenshot requests, deriving legacy requests when absent."""
    try:
        request_limit = max(1, min(8, int(max_requests)))
    except (TypeError, ValueError):
        request_limit = 4

    explicit_requests = []
    seen_requests = set()
    for item in _extract_comic_json_objects(comic_text):
        if str(item.get("kind") or "").strip().lower() != "reference":
            continue
        timestamps = _normalize_reference_timestamps(item)
        evidence_role = _clean_prompt_text(item.get("evidenceRole")).lower()
        legacy_must_show = _clean_prompt_text(item.get("mustShow"))
        reference_usage = _clean_prompt_text(item.get("referenceUsage"), legacy_must_show)
        if not timestamps or not reference_usage:
            continue

        capture_mode = _clean_prompt_text(item.get("captureMode"), "individual").lower()
        capture_mode = {
            "single": "individual",
            "sequence": "sheet",
            "contact_sheet": "sheet",
        }.get(capture_mode, capture_mode)
        if capture_mode not in {"individual", "sheet"}:
            capture_mode = "individual" if len(timestamps) == 1 else "sheet"
        if capture_mode == "sheet" and len(timestamps) == 1:
            capture_mode = "individual"
        window_start = _coerce_timestamp_seconds(
            item.get("windowStartSeconds", item.get("startSeconds"))
        )
        window_end = _coerce_timestamp_seconds(
            item.get("windowEndSeconds", item.get("endSeconds"))
        )
        if window_start is None or window_end is None or window_end <= window_start:
            window_start = None
            window_end = None

        request_key = (tuple(round(value, 1) for value in timestamps), reference_usage)
        if request_key in seen_requests:
            continue
        seen_requests.add(request_key)
        explicit_requests.append({
            "requestSource": "script_reference",
            "timestampSeconds": timestamps[0],
            "timestampsSeconds": timestamps,
            "evidenceRole": evidence_role or None,
            "mustShow": legacy_must_show or None,
            "referenceUsage": reference_usage,
            "captureMode": capture_mode,
            "windowStartSeconds": window_start,
            "windowEndSeconds": window_end,
        })
        if len(explicit_requests) >= 8:
            break

    if explicit_requests:
        # Request order is the planner's importance order. Do not reinterpret it
        # with domain-specific role priorities in post-processing code.
        selected = explicit_requests[:request_limit]

        for index, request in enumerate(selected, start=1):
            request["referenceRequestId"] = f"E{index}"
        return selected

    # Policy v6 and older scripts only contain narrative beats. Treat their
    # referenceUsage fields as soft, single-frame evidence for compatibility.
    normalized = []
    for shot in extract_storyboard_shots(comic_text, request_limit):
        usage = shot.get("referenceUsage") or "核对该时刻的场景、界面和道具"
        normalized.append({
            "referenceRequestId": f"E{len(normalized) + 1}",
            "requestSource": "storyboard_fallback",
            "timestampSeconds": shot["timestampSeconds"],
            "timestampsSeconds": [shot["timestampSeconds"]],
            "evidenceRole": None,
            "mustShow": None,
            "referenceUsage": usage,
            "captureMode": "individual",
            "windowStartSeconds": None,
            "windowEndSeconds": None,
            "scene": shot.get("scene"),
            "visualIntent": shot.get("visualIntent"),
        })
    return normalized
