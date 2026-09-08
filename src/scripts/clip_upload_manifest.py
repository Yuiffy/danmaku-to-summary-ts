#!/usr/bin/env python
"""Read the structured JSON contract shared by clip upload producers."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
try:
    from .clip_qa import validate_metadata_qa, validate_registry_qa
except ImportError:
    from clip_qa import validate_metadata_qa, validate_registry_qa


MANIFEST_TYPE = "bilibili_clip_upload_manifest"


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def _resolve_optional_path(value: Any, base_dir: Path) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    candidate = Path(text).expanduser()
    if not candidate.is_absolute():
        candidate = base_dir / candidate
    return str(candidate.resolve())


def _clock(value: Any) -> str:
    text = str(value or "").strip()
    if ":" in text:
        parts = text.split(":")
        if len(parts) == 3:
            try:
                hours, minutes, seconds = (int(float(part)) for part in parts)
                return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
            except ValueError:
                pass
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return "00:00:00"
    if not math.isfinite(seconds):
        return "00:00:00"
    total = max(0, int(round(seconds)))
    hours, remainder = divmod(total, 3600)
    minutes, seconds_value = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds_value:02d}"


def _tags(value: Any) -> List[str]:
    if isinstance(value, str):
        values: Iterable[Any] = value.replace("，", ",").split(",")
    elif isinstance(value, (list, tuple, set)):
        values = value
    else:
        values = []
    result: List[str] = []
    for value_item in values:
        tag = str(value_item or "").strip()
        if tag and tag not in result:
            result.append(tag)
    return result


def _int_or(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _unwrap_clip(
    item: Any,
    manifest_dir: Path,
) -> Tuple[Dict[str, Any], Dict[str, Any], str]:
    if isinstance(item, str):
        metadata_path = _resolve_optional_path(item, manifest_dir)
        metadata = _read_json(Path(metadata_path))
        return {}, metadata, metadata_path
    if not isinstance(item, dict):
        raise ValueError("manifest clip must be an object or metadata path")

    wrapper = item
    metadata = item.get("metadata")
    metadata_path = item.get("metadataPath") or item.get("jsonPath")
    if metadata_path:
        resolved_metadata_path = _resolve_optional_path(metadata_path, manifest_dir)
        metadata = _read_json(Path(resolved_metadata_path))
        return wrapper, metadata if isinstance(metadata, dict) else {}, resolved_metadata_path
    if isinstance(metadata, dict):
        return wrapper, metadata, ""
    return wrapper, item, ""


def load_upload_manifest(
    manifest_path: str | Path,
    *,
    default_source: str = "",
    default_tags: Optional[Iterable[str]] = None,
    default_prefix: str = "",
    default_tid: int = 21,
    review_path: str = "",
) -> List[Dict[str, Any]]:
    """Load a batch manifest or a single generated clip metadata JSON.

    The returned shape intentionally matches the historical ``batch_upload``
    clip shape, while retaining the structured JSON paths and upload fields.
    """
    path = Path(manifest_path).expanduser().resolve()
    payload = _read_json(path)
    if isinstance(payload, list):
        context: Dict[str, Any] = {}
        items = payload
    elif isinstance(payload, dict) and isinstance(payload.get("clips"), list):
        context = payload
        items = payload["clips"]
    elif isinstance(payload, dict) and (
        isinstance(payload.get("copy"), dict)
        or isinstance(payload.get("output"), dict)
    ):
        context = {}
        items = [payload]
    else:
        raise ValueError(f"unsupported upload JSON shape: {path}")

    context_upload = context.get("upload") if isinstance(context.get("upload"), dict) else {}
    context_tags = _tags(context_upload.get("tags") or context.get("tags"))
    fallback_tags = _tags(default_tags)
    context_review_path = context.get("reviewPath") or review_path
    resolved_review_path = _resolve_optional_path(context_review_path, path.parent)
    clips: List[Dict[str, Any]] = []
    for position, item in enumerate(items, start=1):
        wrapper, metadata, metadata_path = _unwrap_clip(item, path.parent)
        validate_metadata_qa(metadata)
        copy = metadata.get("copy") if isinstance(metadata.get("copy"), dict) else {}
        output = metadata.get("output") if isinstance(metadata.get("output"), dict) else {}
        window = metadata.get("window") if isinstance(metadata.get("window"), dict) else {}
        wrapper_upload = wrapper.get("upload") if isinstance(wrapper.get("upload"), dict) else {}
        metadata_upload = metadata.get("upload") if isinstance(metadata.get("upload"), dict) else {}
        upload = {**context_upload, **wrapper_upload, **metadata_upload}

        start_value = window.get("start", wrapper.get("start", metadata.get("start", 0)))
        duration_value = window.get("duration", wrapper.get("duration", metadata.get("duration")))
        if duration_value in (None, ""):
            end_value = window.get("end", wrapper.get("end", metadata.get("end", start_value)))
            try:
                duration_value = float(end_value) - float(start_value)
            except (TypeError, ValueError):
                duration_value = 0

        title = copy.get("title") or wrapper.get("title") or metadata.get("title") or ""
        source = (
            upload.get("source")
            or metadata.get("uploadSource")
            or wrapper.get("source")
            or context.get("source")
            or default_source
        )
        prefix = (
            upload.get("prefix")
            or wrapper.get("prefix")
            or context.get("prefix")
            or default_prefix
        )
        raw_tags = (
            upload.get("tags")
            or copy.get("tags")
            or wrapper.get("tags")
            or context_tags
            or fallback_tags
        )
        tags = _tags(raw_tags)
        tid = _int_or(
            upload.get("tid")
            or wrapper.get("tid")
            or context.get("tid"),
            default_tid,
        )
        room_id = str(
            upload.get("roomId")
            or metadata.get("roomId")
            or wrapper.get("roomId")
            or context.get("roomId")
            or ""
        ).strip()
        streamer_name = str(
            upload.get("streamerName")
            or metadata.get("streamerName")
            or wrapper.get("streamerName")
            or context.get("streamerName")
            or ""
        ).strip()
        media_path = _resolve_optional_path(
            output.get("mediaPath")
            or wrapper.get("mediaPath")
            or wrapper.get("path"),
            path.parent,
        )
        cover_path = _resolve_optional_path(
            output.get("coverPath")
            or wrapper.get("coverPath")
            or wrapper.get("cover"),
            path.parent,
        )
        item_review_path = _resolve_optional_path(
            wrapper.get("reviewPath") or resolved_review_path,
            path.parent,
        )
        if not metadata_path:
            metadata_path = _resolve_optional_path(
                output.get("metadataPath"),
                path.parent,
            )
        index = _int_or(
            wrapper.get("reviewIndex")
            or wrapper.get("idx")
            or metadata.get("reviewIndex")
            or position,
            position,
        )
        selection_source = str(
            wrapper.get("selectionSource")
            or metadata.get("selectionSource")
            or (metadata.get("candidate") or {}).get("selectionSource", "")
            or ""
        ).strip()
        clips.append(
            {
                "idx": index,
                "reviewIndex": index,
                "title": str(title).strip(),
                "start": _clock(start_value),
                "duration": _clock(duration_value),
                "path": media_path,
                "mediaPath": media_path,
                "cover": cover_path,
                "coverPath": cover_path,
                "selectionSource": selection_source,
                "metadataPath": metadata_path,
                "pendingCut": metadata.get("status") in ("pending_preflight", "render_queued") and not media_path,
                "candidateIndex": str(window.get("index") or ""),
                "candidateSrtPath": (metadata.get("candidateSubtitles") or {}).get("path", ""),
                "candidateRevision": (metadata.get("candidateSubtitles") or {}).get("revision"),
                "candidateSrtSha256": (metadata.get("candidateSubtitles") or {}).get("sha256", ""),
                **({"qaRequired": True} if metadata.get("qaRequired") else {}),
                **({"attributionRequired": True} if metadata.get("attributionRequired") else {}),
                "manifestPath": str(path),
                "reviewPath": item_review_path,
                "source": str(source or "").strip(),
                "prefix": str(prefix or "").strip(),
                "tags": tags,
                "tid": tid,
                "roomId": room_id,
                "streamerName": streamer_name,
                "description": str(copy.get("description") or "").strip(),
            }
        )
    return clips
