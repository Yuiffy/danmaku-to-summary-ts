"""Publish reviewed coordinate comments for automatic keyword clips.

Coordinate comments are derived during clip metadata generation and carried in
the upload manifest.  This module owns the small publication side effect after
an archive has a confirmed Bilibili ``aid``.  Every suggestion gets a durable
journal entry before the POST so an uncertain response is never retried
automatically.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from bilibili_api import comment
from bilibili_api.comment import CommentResourceType
from bilibili_api.exceptions import ResponseCodeException


TIMESTAMP_RE = re.compile(r"^(?:\d{1,2}:)?\d{1,2}:\d{2}$|^\d{1,3}:\d{2}$", re.UNICODE)
MAX_COMMENT_CHARS = 200
DEFAULT_JOURNAL_DIRECTORY = Path(__file__).resolve().parents[2] / "data" / "runtime" / "clip-coordinate-comments"


def _positive_id(value: Any) -> str:
    text = str(value or "").strip()
    return text if re.fullmatch(r"[1-9]\d*", text) else ""


def _text(value: Any, limit: int = MAX_COMMENT_CHARS) -> str:
    text = str(value or "").strip()
    return text[:limit]


def coordinate_comment_config(config: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    root = config if isinstance(config, dict) else {}
    clip_topics = root.get("clipTopics") if isinstance(root.get("clipTopics"), dict) else {}
    value = clip_topics.get("coordinateComments")
    return value if isinstance(value, dict) else {}


def automatic_coordinate_comments_enabled(config: Optional[Dict[str, Any]]) -> bool:
    value = coordinate_comment_config(config)
    return value.get("mode") == "auto" and value.get("enabled", True) is not False


def eligible_coordinate_comments(clip: Dict[str, Any], config: Optional[Dict[str, Any]]) -> bool:
    if not automatic_coordinate_comments_enabled(config):
        return False
    if str(clip.get("publicationKind") or "") != "keyword_topic":
        return False
    # Manual uploads keep the old no-side-effect behaviour.  Automatic topic
    # publication sets this flag when its final review grants queue authority.
    return bool(clip.get("automaticPublicationRequired"))


def normalize_suggestions(value: Any) -> List[Dict[str, str]]:
    if not isinstance(value, list):
        return []
    normalized: List[Dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        timestamp = _text(item.get("timestamp"), 16)
        content = _text(item.get("content"))
        if not timestamp or not TIMESTAMP_RE.fullmatch(timestamp) or not content:
            continue
        source_cue_id = _text(item.get("sourceCueId"), 80)
        row = {"timestamp": timestamp, "content": content}
        if source_cue_id:
            row["sourceCueId"] = source_cue_id
        if row not in normalized:
            normalized.append(row)
    return normalized


def suggestion_key(bvid: str, suggestion: Dict[str, str]) -> str:
    raw = f"{bvid}\0{suggestion['timestamp']}\0{suggestion['content']}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _journal_path(directory: Path, key: str) -> Path:
    return directory / f"{key}.json"


def _load_journal(path: Path) -> Dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, OSError, UnicodeError, json.JSONDecodeError):
        return {}


def _save_journal(path: Path, value: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def record_existing_coordinate_comment(
    *, bvid: str, aid: str, suggestion: Dict[str, str], reply_id: str,
    journal_directory: Path = DEFAULT_JOURNAL_DIRECTORY,
) -> Path:
    """Record a comment that was published by a one-off/manual operator action."""
    bvid = _positive_id(bvid) if bvid.isdigit() else str(bvid or "").strip()
    aid = _positive_id(aid)
    reply_id = _positive_id(reply_id)
    if not bvid or not aid or not reply_id:
        raise ValueError("Invalid existing coordinate comment receipt")
    normalized = normalize_suggestions([suggestion])
    if not normalized:
        raise ValueError("Invalid coordinate comment suggestion")
    row = normalized[0]
    key = suggestion_key(bvid, row)
    path = _journal_path(journal_directory, key)
    _save_journal(path, {
        "schemaVersion": 1, "key": key, "bvid": bvid, "aid": aid,
        "suggestion": row, "state": "published", "replyId": reply_id,
        "publishedAt": time.time(), "source": "manual_operator",
    })
    return path


async def publish_coordinate_comments(
    clip: Dict[str, Any], upload_result: Dict[str, Any], credential: Any,
    config: Optional[Dict[str, Any]],
    *, journal_directory: Path = DEFAULT_JOURNAL_DIRECTORY,
) -> Dict[str, Any]:
    """Publish eligible suggestions once and return durable per-item outcomes."""
    if not eligible_coordinate_comments(clip, config):
        return {"status": "skipped", "items": []}
    bvid = str(upload_result.get("bvid") or "").strip()
    aid = _positive_id(upload_result.get("aid"))
    if not bvid or not aid:
        return {"status": "blocked", "reason": "confirmed aid unavailable", "items": []}

    items: List[Dict[str, Any]] = []
    for suggestion in normalize_suggestions(clip.get("commentSuggestions")):
        key = suggestion_key(bvid, suggestion)
        path = _journal_path(journal_directory, key)
        previous = _load_journal(path)
        if previous.get("state") in {"published", "unknown", "rejected"}:
            items.append({"suggestion": suggestion, "state": previous.get("state"),
                          **({"replyId": previous.get("replyId")} if previous.get("replyId") else {})})
            continue

        journal = {
            "schemaVersion": 1, "key": key, "bvid": bvid, "aid": aid,
            "suggestion": suggestion, "state": "ready", "createdAt": time.time(),
        }
        _save_journal(path, journal)
        journal["state"] = "publishing"
        journal["startedAt"] = time.time()
        _save_journal(path, journal)
        try:
            result = await comment.send_comment(
                text=suggestion["timestamp"] + " " + suggestion["content"],
                oid=int(aid), type_=CommentResourceType.VIDEO, credential=credential,
            )
            reply_id = _positive_id(result.get("rpid_str") or result.get("rpid")) if isinstance(result, dict) else ""
            if not reply_id:
                raise RuntimeError("coordinate comment receipt missing")
            journal.update({"state": "published", "replyId": reply_id, "publishedAt": time.time()})
            _save_journal(path, journal)
            items.append({"suggestion": suggestion, "state": "published", "replyId": reply_id})
        except ResponseCodeException as error:
            # A platform rejection is final for this exact suggestion.  The
            # worker must not keep POSTing against a closed/blocked comment area.
            journal.update({"state": "rejected", "error": str(error)[:300], "rejectedAt": time.time()})
            _save_journal(path, journal)
            items.append({"suggestion": suggestion, "state": "rejected", "error": str(error)[:300]})
        except Exception as error:
            # Network/unknown outcomes are retained and require an explicit
            # reconciliation command; automatic retry could duplicate a comment.
            journal.update({"state": "unknown", "error": str(error)[:300], "unknownAt": time.time()})
            _save_journal(path, journal)
            items.append({"suggestion": suggestion, "state": "unknown", "error": str(error)[:300]})

    states = {str(item.get("state")) for item in items}
    status = "published" if states and states <= {"published"} else "partial" if "published" in states else "failed"
    return {"status": status, "items": items}


__all__ = [
    "DEFAULT_JOURNAL_DIRECTORY", "automatic_coordinate_comments_enabled",
    "coordinate_comment_config", "eligible_coordinate_comments",
    "normalize_suggestions", "publish_coordinate_comments",
    "record_existing_coordinate_comment", "suggestion_key",
]
