"""Rolling account upload policy. No network, filesystem, queue locks or publication."""

import datetime as dt
from typing import Any, Dict, Iterable, List, Optional


def parse_utc_timestamp(value: Any) -> Optional[dt.datetime]:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def normalize_utc_now(value: Optional[dt.datetime] = None) -> dt.datetime:
    current = value or dt.datetime.now(dt.timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=dt.timezone.utc)
    return current.astimezone(dt.timezone.utc)


def rolling_upload_event_key(event: Dict[str, Any]) -> str:
    if event.get("bvid"):
        return f"bvid:{event['bvid']}"
    if event.get("aid"):
        return f"aid:{event['aid']}"
    if event.get("clipId") is not None:
        return f"clip:{event.get('jobId', '')}:{event['clipId']}"
    return f"at:{event.get('at', '')}:{event.get('title', '')}"


def normalize_rolling_upload_event(event: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(event, dict):
        return None
    submitted_at = parse_utc_timestamp(event.get("at"))
    if submitted_at is None:
        return None
    normalized = {
        key: value
        for key, value in event.items()
        if key
        in (
            "at",
            "bvid",
            "aid",
            "title",
            "source",
            "clipId",
            "jobId",
        )
        and value not in (None, "")
    }
    normalized["at"] = submitted_at.isoformat()
    return normalized


def merge_rolling_upload_events(
    existing: Iterable[Dict[str, Any]],
    incoming: Iterable[Dict[str, Any]],
    now: Optional[dt.datetime] = None,
    *, window_seconds: int,
) -> List[Dict[str, Any]]:
    """Merge remote and local events, keeping the later timestamp conservatively."""
    current = normalize_utc_now(now)
    cutoff = current - dt.timedelta(seconds=window_seconds)
    merged: Dict[str, Dict[str, Any]] = {}
    for raw_event in [*existing, *incoming]:
        event = normalize_rolling_upload_event(raw_event)
        if event is None:
            continue
        event_at = parse_utc_timestamp(event.get("at"))
        if event_at is None or event_at <= cutoff:
            continue
        key = rolling_upload_event_key(event)
        previous = merged.get(key)
        if previous is None:
            merged[key] = event
            continue
        previous_at = parse_utc_timestamp(previous.get("at")) or event_at
        combined = dict(previous)
        combined.update(event)
        combined["at"] = max(previous_at, event_at).isoformat()
        if previous.get("source") == "upload_worker":
            combined["source"] = previous["source"]
        merged[key] = combined
    return sorted(
        merged.values(),
        key=lambda event: parse_utc_timestamp(event.get("at"))
        or dt.datetime.max.replace(tzinfo=dt.timezone.utc),
    )


def ensure_account_upload_guard(
    queue: Dict[str, Any], account_id: str, *, limit: int, window_seconds: int
) -> Dict[str, Any]:
    state = queue.get("accountRollingUploadGuard")
    if not isinstance(state, dict) or str(state.get("accountId")) != str(account_id):
        state = {
            "accountId": str(account_id),
            "limit": limit,
            "windowSeconds": window_seconds,
            "events": [],
        }
        queue["accountRollingUploadGuard"] = state
    state["limit"] = limit
    state["windowSeconds"] = window_seconds
    if not isinstance(state.get("events"), list):
        state["events"] = []
    return state


def recalculate_account_upload_guard(
    state: Dict[str, Any], now: Optional[dt.datetime] = None,
    *, limit: int, window_seconds: int, boundary_buffer_seconds: int
) -> Dict[str, Any]:
    current = normalize_utc_now(now)
    events = merge_rolling_upload_events(state.get("events") or [], [], current, window_seconds=window_seconds)
    state["events"] = events
    state["recentCount"] = len(events)
    if len(events) < limit:
        state.pop("blockedUntil", None)
        return state

    # Enough oldest events must expire to leave at most 89 before the next submit.
    release_index = len(events) - limit
    release_event_at = parse_utc_timestamp(events[release_index].get("at"))
    if release_event_at is None:
        state.pop("blockedUntil", None)
        return state
    blocked_until = release_event_at + dt.timedelta(
        seconds=(
            window_seconds
            + boundary_buffer_seconds
        )
    )
    state["blockedUntil"] = blocked_until.isoformat()
    return state


def account_upload_limit_active(
    queue: Dict[str, Any], now: Optional[dt.datetime] = None
) -> bool:
    state = queue.get("accountRollingUploadGuard")
    if not isinstance(state, dict):
        return False
    blocked_until = parse_utc_timestamp(state.get("blockedUntil"))
    if blocked_until is None:
        return False
    return blocked_until > normalize_utc_now(now)


def account_upload_available_slots(state: Dict[str, Any], *, limit: int) -> int:
    try:
        recent_count = int(state.get("recentCount") or 0)
    except (TypeError, ValueError):
        recent_count = 0
    return max(0, limit - recent_count)
