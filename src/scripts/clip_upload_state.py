"""Short, locked upload-worker snapshots and status-only registry commits."""

import copy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


@dataclass(frozen=True)
class UploadStateIO:
    REGISTRY_PATH: Path
    QUEUE_PATH: Path
    acquire_queue_mutation_lock: Callable[[], Any]
    release_queue_mutation_lock: Callable[[Any], None]
    load_json: Callable[[Path, dict], dict]
    save_json: Callable[[Path, dict], None]
    default_registry: Callable[[], dict]
    default_queue: Callable[[], dict]
    normalize_registry_media_paths: Callable[[dict], bool]


STATUS_FIELDS = ("status", "updatedAt", "failureReason", "uploadState", "uploadedAt")


def load_worker_snapshot(api: UploadStateIO):
    """Read the registry and queue from the same enqueue transaction boundary."""
    handle = api.acquire_queue_mutation_lock()
    try:
        registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
        queue = api.load_json(api.QUEUE_PATH, api.default_queue())
        if api.normalize_registry_media_paths(registry):
            api.save_json(api.REGISTRY_PATH, registry)
        return registry, queue
    finally:
        api.release_queue_mutation_lock(handle)


def commit_worker_statuses(api: UploadStateIO, snapshot, ids):
    """Preserve current authorization, media and unrelated IDs while saving progress."""
    handle = api.acquire_queue_mutation_lock()
    try:
        latest = api.load_json(api.REGISTRY_PATH, api.default_registry())
        for clip_id in ids:
            key = str(clip_id)
            source, target = snapshot.get("clips", {}).get(key), latest.get("clips", {}).get(key)
            if not source or not target:
                continue
            if target.get("status") == "uploaded" and source.get("status") != "uploaded":
                continue
            for field in STATUS_FIELDS:
                if field in source:
                    target[field] = copy.deepcopy(source[field])
                else:
                    target.pop(field, None)
        api.save_json(api.REGISTRY_PATH, latest)
        return latest
    finally:
        api.release_queue_mutation_lock(handle)
