"""Structured clip imports, including reserved IDs for unrendered candidates."""

import argparse
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any, Dict, List, Optional


def import_json(args: argparse.Namespace, api: ModuleType) -> int:
    """Called under the registry mutation lock; the API preserves CLI/test paths."""
    manifest_path = Path(args.manifest).expanduser().resolve()
    if not manifest_path.exists():
        print(f"[ERROR] upload manifest not found: {manifest_path}", file=sys.stderr)
        return 2
    try:
        clips = api.load_upload_manifest(
            manifest_path, default_source=args.source or "", default_tags=api.parse_tags(args.tags),
            default_prefix=args.prefix or "", default_tid=int(args.tid or 21), review_path=args.review or "",
            allow_pending_review=bool(getattr(args, "include_pending", False)))
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        print(f"[ERROR] cannot read upload JSON {manifest_path}: {exc}", file=sys.stderr)
        return 2
    if not clips:
        print(f"[ERROR] no clips found in upload JSON: {manifest_path}", file=sys.stderr)
        return 2

    first = clips[0]
    source = str(args.source or first.get("source") or "").strip()
    tags = api.parse_tags(args.tags) if args.tags else api.parse_tags(first.get("tags") or [])
    prefix = str(args.prefix or first.get("prefix") or "").strip()
    tid = int(args.tid or first.get("tid") or 21)
    state_path = Path(args.state).expanduser().resolve() if args.state else manifest_path.parent / "upload_state.json"
    review_value = args.review or first.get("reviewPath") or ""
    review_str = api.normalize_path(review_value) if review_value else ""
    manifest_str = api.normalize_path(manifest_path)
    state_str = api.normalize_path(state_path)
    batch_id = args.batch_id or api.batch_key(manifest_str, source, prefix, tags, tid, state_str)
    registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
    api.normalize_registry_media_paths(registry)

    def find_existing_id(clip: Dict[str, Any]) -> Optional[int]:
        metadata_path = clip.get("metadataPath") or ""
        review_index = int(clip.get("reviewIndex") or clip.get("idx") or 0)
        media_path = clip.get("mediaPath") or clip.get("path") or ""
        for existing_id, record in registry.get("clips", {}).items():
            if not isinstance(record, dict):
                continue
            if metadata_path and api.paths_match(record.get("metadataPath") or "", metadata_path):
                return int(existing_id)
            same_index = int(record.get("reviewIndex") or 0) == review_index
            same_media = bool(media_path) and api.paths_match(record.get("mediaPath") or "", media_path)
            if same_index and same_media and (record.get("manifestPath") == manifest_str
                                              or (review_str and record.get("reviewPath") == review_str)):
                return int(existing_id)
        return None

    ids: List[int] = []
    for clip in clips:
        clip_id = find_existing_id(clip)
        record_data = {
            "batchId": batch_id, "manifestPath": manifest_str,
            "metadataPath": api.normalize_path(clip["metadataPath"]) if clip.get("metadataPath") else "",
            "reviewPath": review_str or clip.get("reviewPath") or "", "statePath": state_str,
            "reviewPlanPath": clip.get("reviewPlanPath") or "",
            "source": clip.get("source") or source, "prefix": clip.get("prefix") or prefix,
            "tags": api.parse_tags(clip.get("tags") or tags), "tid": int(clip.get("tid") or tid),
            "title": clip.get("title") or "", "start": clip.get("start") or "00:00:00",
            "duration": clip.get("duration") or "00:00:00",
            "mediaPath": clip.get("mediaPath") or clip.get("path") or "",
            "coverPath": clip.get("coverPath") or clip.get("cover") or "",
            "selectionSource": clip.get("selectionSource") or "", "roomId": clip.get("roomId") or "",
            "streamerName": clip.get("streamerName") or "", "description": clip.get("description") or "",
            "reviewIndex": int(clip.get("reviewIndex") or clip.get("idx") or len(ids) + 1),
            "sourceFormat": "json", "qaRequired": bool(clip.get("qaRequired")),
            "attributionRequired": bool(clip.get("attributionRequired")),
            "humanReviewRequired": bool(clip.get("humanReviewRequired")),
            "reviewPending": bool(clip.get("reviewPending")),
            "reviewIssues": clip.get("reviewIssues") or [],
            "publicCopyPending": bool(clip.get("publicCopyPending")),
            "attributionStatus": clip.get("attributionStatus"),
            "srtPath": clip.get("srtPath") or "",
            "sourceMediaPath": clip.get("sourceMediaPath") or "",
            "pendingCut": bool(clip.get("pendingCut")), "candidateIndex": clip.get("candidateIndex") or "",
            "pendingRebuild": bool(clip.get("pendingRebuild")), "subtitleRevisionKind": clip.get("subtitleRevisionKind") or "",
            **{key: clip.get(key) for key in ("candidateSrtPath", "candidateRevision", "candidateSrtSha256")},
            "reviewPreview": clip.get("reviewPreview"),
        }
        if clip_id is None:
            clip_id = int(registry.get("nextClipId") or 1)
            registry["nextClipId"] = clip_id + 1
            registry.setdefault("clips", {})[str(clip_id)] = {
                "id": clip_id, "createdAt": api.now_iso(), "updatedAt": api.now_iso(),
                "status": "pending_rebuild" if clip.get("pendingRebuild") else (
                    "needs_review" if clip.get("reviewPending") else ("pending_cut" if clip.get("pendingCut") else "review")), **record_data,
            }
        else:
            record = registry["clips"][str(clip_id)]
            if not record_data["reviewPlanPath"]:
                record_data["reviewPlanPath"] = record.get("reviewPlanPath") or ""
            for required in ("qaRequired", "attributionRequired", "humanReviewRequired"):
                if record.get(required) and not record_data.get(required):
                    record_data[required] = True
                    record_data["reviewPending"] = True
                    record_data["reviewIssues"].append(f"required review flag removed: {required}")
            # A stale preflight import must not erase an already rendered clip.
            if not clip.get("pendingCut") or not record.get("mediaPath"):
                if record.get("pendingCut") and not clip.get("pendingCut") and record.get("reviewPath"):
                    record.setdefault("candidateReviewPath", record["reviewPath"])
                if record.get("status") in ("review", "pending_cut", "pending_rebuild", "needs_review"):
                    record["status"] = "pending_rebuild" if clip.get("pendingRebuild") else (
                        "needs_review" if record_data["reviewPending"] else ("pending_cut" if clip.get("pendingCut") else "review"))
                record.update({"updatedAt": api.now_iso(), **record_data})
        ids.append(clip_id)

    registry.setdefault("batches", {})[batch_id] = {
        "id": batch_id, "label": args.label or source,
        "createdAt": registry.get("batches", {}).get(batch_id, {}).get("createdAt") or api.now_iso(),
        "updatedAt": api.now_iso(), "manifestPath": manifest_str,
        "reviewPath": review_str or first.get("reviewPath") or "", "statePath": state_str,
        "source": source, "prefix": prefix, "tags": tags, "tid": tid, "clipIds": ids, "sourceFormat": "json",
    }
    api.save_json(api.REGISTRY_PATH, registry)
    print(f"[OK] imported {len(ids)} clips from {manifest_path}")
    print("IDs:", ",".join(str(i) for i in ids))
    records = [registry["clips"][str(clip_id)] for clip_id in ids]
    print("REGISTRY_RESULT:", json.dumps({
        "clipIds": ids,
        "clipIdsByReviewIndex": {str(record["reviewIndex"]): record["id"] for record in records},
        "reviewPendingByReviewIndex": {str(record["reviewIndex"]): bool(record.get("reviewPending")) for record in records},
        "reviewIssuesByReviewIndex": {str(record["reviewIndex"]): record.get("reviewIssues") or [] for record in records},
        "clipStatusByReviewIndex": {str(record["reviewIndex"]): record.get("status") for record in records},
    }, ensure_ascii=False))
    return 0
