"""Parse legacy REVIEW text and normalize imported registry fields."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

INTERNAL_REVIEW_LABEL_RE = re.compile(r"^\[(?:模型全量|模型分块|弹幕热度|本地规则)\]\s*")
REVIEW_SCORE_SUFFIX_RE = re.compile(r"\s+\|\s+\d+(?:\.\d+)?分\s*$")


def normalize_path(value: str | Path) -> str:
    return str(Path(value).expanduser().resolve())


def parse_int_list(value: str) -> List[int]:
    ids: List[int] = []
    for part in re.split(r"[,，\s]+", str(value or "")):
        if not part:
            continue
        ids.append(int(part))
    return ids


def parse_tags(value: str | Iterable[str]) -> List[str]:
    if isinstance(value, str):
        raw = re.split(r"[,，]", value)
    else:
        raw = value
    return [str(tag).strip() for tag in raw if str(tag).strip()]


def strip_internal_review_label(title: str) -> str:
    """Remove the source label used for local REVIEW.md display, not upload titles."""
    return INTERNAL_REVIEW_LABEL_RE.sub("", str(title or "").strip(), count=1)


def strip_review_score_suffix(value: str) -> str:
    """Remove the recommendation score appended after a REVIEW media path."""
    return REVIEW_SCORE_SUFFIX_RE.sub("", str(value or "")).strip()


def normalize_registry_media_paths(registry: Dict[str, Any]) -> bool:
    """Repair paths imported before REVIEW score suffix handling was fixed."""
    changed = False
    for clip in (registry.get("clips") or {}).values():
        if not isinstance(clip, dict):
            continue
        media_path = clip.get("mediaPath")
        normalized = strip_review_score_suffix(media_path)
        if media_path and normalized != media_path:
            clip["mediaPath"] = normalized
            changed = True
    return changed


def parse_review(review_path: Path) -> List[Dict[str, Any]]:
    clips: List[Dict[str, Any]] = []
    cover_by_idx: Dict[int, str] = {}
    selection_source_by_idx: Dict[int, str] = {}
    previous_idx: Optional[int] = None
    with review_path.open("r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.rstrip("\n")
            m = re.match(
                r"^(\d+)\.\s*(.+?)\s*\|\s*(\d{2}:\d{2}:\d{2})\s*\|\s*(\d{2}:\d{2}:\d{2})\s*\|?\s*(.+)?$",
                line.strip(),
            )
            if m:
                previous_idx = int(m.group(1))
                clips.append(
                    {
                        "reviewIndex": previous_idx,
                        "title": strip_internal_review_label(m.group(2)),
                        "start": m.group(3).strip(),
                        "duration": m.group(4).strip(),
                        "mediaPath": strip_review_score_suffix(m.group(5)),
                    }
                )
                continue
            source_match = re.match(r"^\s*来源:\s*(.+?)\s*$", line)
            if source_match and previous_idx is not None:
                selection_source_by_idx[previous_idx] = source_match.group(1).strip()
                continue
            cm = re.match(r"^\s*封面:\s*(.+?)\s*$", line)
            if cm and previous_idx is not None:
                cover_by_idx[previous_idx] = cm.group(1).strip()

    for clip in clips:
        clip["selectionSource"] = selection_source_by_idx.get(clip["reviewIndex"], "")
        cover = cover_by_idx.get(clip["reviewIndex"])
        if cover:
            clip["coverPath"] = cover
    return clips
