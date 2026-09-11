#!/usr/bin/env python
"""Short-id registry and queue for reviewed Bilibili clip uploads."""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import errno
import json
import os
import re
import secrets
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional

import requests

try:
    from .clip_upload_manifest import load_upload_manifest, validate_registry_qa, find_review_manifest
    from . import clip_candidate_queue
except ImportError:
    from clip_upload_manifest import load_upload_manifest, validate_registry_qa, find_review_manifest
    import clip_candidate_queue

PROJECT_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_DIR = PROJECT_ROOT / "data" / "runtime"
REGISTRY_PATH = RUNTIME_DIR / "clip_upload_registry.json"
QUEUE_PATH = RUNTIME_DIR / "clip_upload_queue.json"
LOCK_PATH = RUNTIME_DIR / "clip_upload_worker.lock"
QUEUE_MUTATION_LOCK_WAIT_SECONDS = 30
DEFAULT_DELAY = 60
DEFAULT_RATE_LIMIT_WAIT = 120
DEFAULT_RATE_LIMIT_RETRIES = 5
DEFAULT_BATCH_SIZE = 4
DEFAULT_BATCH_TIMEOUT_SECONDS = 30 * 60
DEFAULT_RETRY_DELAY_SECONDS = 10 * 60
MAX_AUTOMATIC_JOB_RETRIES = 8
BILIBILI_SUBMISSION_RATE_LIMIT_CODE = 137022
SUBMISSION_RATE_LIMIT_BASE_DELAY_SECONDS = 20 * 60
SUBMISSION_RATE_LIMIT_MAX_DELAY_SECONDS = 24 * 60 * 60
ACCOUNT_ROLLING_UPLOAD_LIMIT = 90
ACCOUNT_ROLLING_WINDOW_SECONDS = 24 * 60 * 60
ACCOUNT_ROLLING_BOUNDARY_BUFFER_SECONDS = 5
ACCOUNT_ARCHIVE_REFRESH_SECONDS = 5 * 60
ACCOUNT_ARCHIVE_MAX_PAGES = 5
DEFAULT_BILIBILI_ACCOUNT_ID = "412141275"
CHINA_TIMEZONE = dt.timezone(dt.timedelta(hours=8))
TERMINAL_UPLOAD_ERROR_MARKERS = (
    "视频文件不存在",
    "文件不存在:",
    "metadata json not found",
    "upload manifest not found",
    "no clips found in upload json",
    "unsupported upload json shape",
    "无法读取上传 json",
    "上传 json 中未找到切片",
    "no such file or directory",
    "review.md not found",
    "cannot read review",
    "cannot read review.md",
    "no clips found in review",
    "review.md 中未找到切片",
    "invalid_video",
    "video validation failed",
    "no video stream",
    "video too short",
    "无法创建封面",
    "no_cover",
)
LOCK_OWNER_TOKEN: Optional[str] = None
INTERNAL_REVIEW_LABEL_RE = re.compile(r"^\[(?:模型全量|模型分块|弹幕热度|本地规则)\]\s*")
REVIEW_SCORE_SUFFIX_RE = re.compile(r"\s+\|\s+\d+(?:\.\d+)?分\s*$")


def hidden_subprocess_kwargs() -> Dict[str, Any]:
    """Prevent nested console programs from flashing a window on Windows."""
    if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


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


def load_upload_runtime_config() -> Dict[str, Any]:
    try:
        from .config_loader import get_config
    except ImportError:
        from config_loader import get_config
    return get_config()


def configured_upload_account() -> tuple[str, str, str]:
    """Return the active Bilibili account id, cookie, and WeChat webhook."""
    config = load_upload_runtime_config()
    bilibili = config.get("bilibili") or {}
    cookie = str(bilibili.get("cookie") or "").strip()
    account_id = ""
    for part in cookie.split(";"):
        if "=" not in part:
            continue
        key, value = part.strip().split("=", 1)
        if key.strip().lower() == "dedeuserid":
            account_id = value.strip()
            break
    webhook_url = str(
        (config.get("wechatWork") or {}).get("webhookUrl") or ""
    ).strip()
    return account_id or DEFAULT_BILIBILI_ACCOUNT_ID, cookie, webhook_url


def fetch_recent_account_submissions(
    cookie: str,
    account_id: str,
    now: Optional[dt.datetime] = None,
) -> List[Dict[str, Any]]:
    """Read the account's current rolling-window submissions from Creator Center."""
    if not cookie:
        raise RuntimeError("Bilibili cookie is not configured")

    current = normalize_utc_now(now)
    cutoff = current - dt.timedelta(seconds=ACCOUNT_ROLLING_WINDOW_SECONDS)
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36"
        ),
        "Cookie": cookie,
        "Referer": "https://member.bilibili.com/",
    }
    events: List[Dict[str, Any]] = []
    for page in range(1, ACCOUNT_ARCHIVE_MAX_PAGES + 1):
        response = requests.get(
            "https://member.bilibili.com/x/web/archives",
            params={
                "mid": account_id,
                "pn": page,
                "ps": 50,
                "typeid": 0,
                "status": "all",
            },
            headers=headers,
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("code") != 0:
            raise RuntimeError(
                "Creator Center archives returned "
                f"code={payload.get('code')}: {payload.get('message', '')}"
            )
        audits = (payload.get("data") or {}).get("arc_audits") or []
        if not audits:
            break

        reached_cutoff = False
        for audit in audits:
            archive = audit.get("Archive") or audit.get("archive") or {}
            raw_timestamp = archive.get("pubdate") or archive.get("ctime")
            try:
                submitted_at = dt.datetime.fromtimestamp(
                    int(raw_timestamp), tz=dt.timezone.utc
                )
            except (TypeError, ValueError, OSError, OverflowError):
                continue
            if submitted_at <= cutoff:
                reached_cutoff = True
                continue
            events.append(
                {
                    "at": submitted_at.isoformat(),
                    "bvid": str(archive.get("bvid") or ""),
                    "aid": archive.get("aid"),
                    "title": str(archive.get("title") or ""),
                    "source": "bilibili_creator_center",
                }
            )
        if reached_cutoff or len(audits) < 50:
            break
    return events


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
) -> List[Dict[str, Any]]:
    """Merge remote and local events, keeping the later timestamp conservatively."""
    current = normalize_utc_now(now)
    cutoff = current - dt.timedelta(seconds=ACCOUNT_ROLLING_WINDOW_SECONDS)
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
    queue: Dict[str, Any], account_id: str
) -> Dict[str, Any]:
    state = queue.get("accountRollingUploadGuard")
    if not isinstance(state, dict) or str(state.get("accountId")) != str(account_id):
        state = {
            "accountId": str(account_id),
            "limit": ACCOUNT_ROLLING_UPLOAD_LIMIT,
            "windowSeconds": ACCOUNT_ROLLING_WINDOW_SECONDS,
            "events": [],
        }
        queue["accountRollingUploadGuard"] = state
    state["limit"] = ACCOUNT_ROLLING_UPLOAD_LIMIT
    state["windowSeconds"] = ACCOUNT_ROLLING_WINDOW_SECONDS
    if not isinstance(state.get("events"), list):
        state["events"] = []
    return state


def registry_submission_events(registry: Dict[str, Any]) -> List[Dict[str, Any]]:
    events: List[Dict[str, Any]] = []
    for clip in (registry.get("clips") or {}).values():
        if not isinstance(clip, dict) or clip.get("status") != "uploaded":
            continue
        upload_state = clip.get("uploadState") or {}
        submitted_at = upload_state.get("submittedAt") or clip.get("uploadedAt")
        if parse_utc_timestamp(submitted_at) is None:
            continue
        events.append(
            {
                "at": submitted_at,
                "bvid": upload_state.get("bvid") or "",
                "aid": upload_state.get("aid"),
                "title": upload_state.get("onlineTitle")
                or upload_state.get("title")
                or full_title(clip),
                "source": "upload_worker",
                "clipId": clip.get("id"),
            }
        )
    return events


def recalculate_account_upload_guard(
    state: Dict[str, Any], now: Optional[dt.datetime] = None
) -> Dict[str, Any]:
    current = normalize_utc_now(now)
    events = merge_rolling_upload_events(state.get("events") or [], [], current)
    state["events"] = events
    state["recentCount"] = len(events)
    if len(events) < ACCOUNT_ROLLING_UPLOAD_LIMIT:
        state.pop("blockedUntil", None)
        return state

    # Enough oldest events must expire to leave at most 89 before the next submit.
    release_index = len(events) - ACCOUNT_ROLLING_UPLOAD_LIMIT
    release_event_at = parse_utc_timestamp(events[release_index].get("at"))
    if release_event_at is None:
        state.pop("blockedUntil", None)
        return state
    blocked_until = release_event_at + dt.timedelta(
        seconds=(
            ACCOUNT_ROLLING_WINDOW_SECONDS
            + ACCOUNT_ROLLING_BOUNDARY_BUFFER_SECONDS
        )
    )
    state["blockedUntil"] = blocked_until.isoformat()
    return state


def refresh_account_upload_guard(
    queue: Dict[str, Any],
    registry: Dict[str, Any],
    now: Optional[dt.datetime] = None,
    force_remote: bool = False,
) -> tuple[Dict[str, Any], bool]:
    current = normalize_utc_now(now)
    account_id, cookie, _ = configured_upload_account()
    before = json.dumps(
        queue.get("accountRollingUploadGuard"),
        ensure_ascii=False,
        sort_keys=True,
    )
    state = ensure_account_upload_guard(queue, account_id)
    state["events"] = merge_rolling_upload_events(
        state.get("events") or [], registry_submission_events(registry), current
    )

    last_sync = parse_utc_timestamp(state.get("lastRemoteSyncAt"))
    remote_due = (
        force_remote
        or last_sync is None
        or (current - last_sync).total_seconds() >= ACCOUNT_ARCHIVE_REFRESH_SECONDS
    )
    if remote_due:
        state["lastRemoteSyncAttemptAt"] = current.isoformat()
        try:
            remote_events = fetch_recent_account_submissions(
                cookie, account_id, current
            )
            state["events"] = merge_rolling_upload_events(
                state.get("events") or [], remote_events, current
            )
            state["lastRemoteSyncAt"] = current.isoformat()
            state["remoteSnapshotCount"] = len(remote_events)
            state.pop("lastRemoteSyncError", None)
        except Exception as error:
            state["lastRemoteSyncError"] = str(error)[:500]
            print(
                f"[worker] unable to refresh rolling upload history: {error}",
                file=sys.stderr,
                flush=True,
            )

    recalculate_account_upload_guard(state, current)
    after = json.dumps(state, ensure_ascii=False, sort_keys=True)
    return state, before != after


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


def account_upload_available_slots(state: Dict[str, Any]) -> int:
    try:
        recent_count = int(state.get("recentCount") or 0)
    except (TypeError, ValueError):
        recent_count = 0
    return max(0, ACCOUNT_ROLLING_UPLOAD_LIMIT - recent_count)


def format_china_timestamp(value: dt.datetime) -> str:
    return normalize_utc_now(value).astimezone(CHINA_TIMEZONE).strftime(
        "%Y-%m-%d %H:%M:%S"
    )


def ensure_runtime_dir() -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)


def load_json(path: Path, default: Dict[str, Any]) -> Dict[str, Any]:
    if not path.exists():
        return json.loads(json.dumps(default))
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def save_json(path: Path, data: Dict[str, Any]) -> None:
    ensure_runtime_dir()
    payload = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    for attempt in range(5):
        try:
            tmp.write_text(payload, encoding="utf-8")
            tmp.replace(path)
            return
        except FileNotFoundError:
            if attempt == 4:
                path.write_text(payload, encoding="utf-8")
                try:
                    tmp.unlink()
                except OSError:
                    pass
                return
            time.sleep(0.2)
        except PermissionError:
            if attempt == 4:
                path.write_text(payload, encoding="utf-8")
                try:
                    tmp.unlink()
                except OSError:
                    pass
                return
            time.sleep(0.2)


class QueueLockTimeout(RuntimeError):
    """Raised when another process holds the queue mutation lock too long."""


def queue_mutation_lock_path() -> Path:
    return QUEUE_PATH.with_name(f"{QUEUE_PATH.name}.lock")


def _lock_file(handle: Any) -> None:
    handle.seek(0)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        return

    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock_file(handle: Any) -> None:
    handle.seek(0)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        return

    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _is_lock_contention(error: OSError) -> bool:
    return error.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK) or getattr(
        error, "winerror", None
    ) in (33, 36)


def acquire_queue_mutation_lock(
    wait_seconds: float = QUEUE_MUTATION_LOCK_WAIT_SECONDS,
) -> Any:
    """Acquire the short-lived cross-process lock used by every queue writer."""
    lock_path = queue_mutation_lock_path()
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+b")
    if handle.seek(0, os.SEEK_END) == 0:
        handle.write(b"\0")
        handle.flush()

    deadline = time.monotonic() + max(float(wait_seconds), 0.0)
    while True:
        try:
            _lock_file(handle)
            return handle
        except OSError as error:
            if not _is_lock_contention(error):
                handle.close()
                raise
            if time.monotonic() >= deadline:
                handle.close()
                raise QueueLockTimeout(
                    f"timed out waiting for upload queue lock: {lock_path}"
                ) from error
            time.sleep(0.05)


def release_queue_mutation_lock(handle: Any) -> None:
    try:
        _unlock_file(handle)
    finally:
        handle.close()


@contextmanager
def queue_transaction() -> Iterator[Dict[str, Any]]:
    """Reload and atomically save the queue while holding its mutation lock."""
    handle = acquire_queue_mutation_lock()
    try:
        queue = load_json(QUEUE_PATH, default_queue())
        yield queue
        save_json(QUEUE_PATH, queue)
    finally:
        release_queue_mutation_lock(handle)


def find_queue_job(queue: Dict[str, Any], job_id: Any) -> Optional[Dict[str, Any]]:
    expected = str(job_id or "")
    return next(
        (
            job
            for job in queue.get("jobs", [])
            if str(job.get("id") or "") == expected
        ),
        None,
    )


def commit_queue_snapshot(
    snapshot: Dict[str, Any],
    *,
    job_ids: Iterable[Any] = (),
    queue_fields: Iterable[str] = (),
) -> Dict[str, Any]:
    """Apply only this worker's changes onto the newest on-disk queue.

    Upload subprocesses can run for minutes. During that time, enqueue may
    append jobs to the same file. Replacing the file with the worker's old
    in-memory snapshot would silently discard those jobs, so worker writes
    merge only the job and queue-level fields they intentionally changed.
    """
    source_jobs = {
        str(job.get("id") or ""): job
        for job in snapshot.get("jobs", [])
        if job.get("id") is not None
    }
    with queue_transaction() as latest:
        latest_jobs = latest.setdefault("jobs", [])
        for raw_job_id in job_ids:
            job_id = str(raw_job_id or "")
            source_job = source_jobs.get(job_id)
            if source_job is None:
                continue
            replacement = copy.deepcopy(source_job)
            for index, existing in enumerate(latest_jobs):
                if str(existing.get("id") or "") == job_id:
                    latest_jobs[index] = replacement
                    break
            else:
                latest_jobs.append(replacement)

        for field in queue_fields:
            if field in snapshot:
                latest[field] = copy.deepcopy(snapshot[field])
            else:
                latest.pop(field, None)
    return latest


def default_registry() -> Dict[str, Any]:
    return {"version": 1, "nextClipId": 1, "batches": {}, "clips": {}}


def default_queue() -> Dict[str, Any]:
    return {"version": 1, "jobs": []}


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


def full_title(clip: Dict[str, Any]) -> str:
    return f"{clip.get('prefix', '')}{clip.get('title', '')}"


def paths_match(a: str, b: str) -> bool:
    if not a or not b:
        return False
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def state_record_matches_clip(clip: Dict[str, Any], record: Any) -> bool:
    if not isinstance(record, dict):
        return False
    if record.get("bvid") or record.get("aid") or record.get("cid"):
        record_path = record.get("mediaPath") or ""
        if record_path and not paths_match(record_path, clip.get("mediaPath") or ""):
            return False
        return True
    return record.get("title") == full_title(clip)


def batch_key(review_path: str, source: str, prefix: str, tags: List[str], tid: int, state_path: str) -> str:
    payload = json.dumps(
        {
            "reviewPath": review_path,
            "source": source,
            "prefix": prefix,
            "tags": tags,
            "tid": tid,
            "statePath": state_path,
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    import hashlib

    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def clip_batch_key(clip: Dict[str, Any]) -> str:
    """Use the machine manifest as the batch identity when available."""
    return batch_key(
        clip.get("manifestPath") or clip.get("reviewPath") or "",
        clip.get("source") or "",
        clip.get("prefix") or "",
        parse_tags(clip.get("tags") or []),
        int(clip.get("tid") or 21),
        clip.get("statePath") or "",
    )


def import_review(args: argparse.Namespace) -> int:
    review_path = Path(args.review).expanduser().resolve()
    if not review_path.exists():
        print(f"[ERROR] REVIEW.md not found: {review_path}", file=sys.stderr)
        return 2
    manifest = find_review_manifest(review_path)
    if manifest:
        return import_json(argparse.Namespace(**{**vars(args), "manifest": str(manifest), "include_pending": True}))
    if '<!-- own-stream-review:v2;' in review_path.read_text(encoding="utf-8-sig"):
        print("[ERROR] generated review requires its JSON upload manifest", file=sys.stderr)
        return 2
    clips = parse_review(review_path)
    if not clips:
        print(f"[ERROR] no clips found in review: {review_path}", file=sys.stderr)
        return 2

    tags = parse_tags(args.tags)
    state_path = Path(args.state).expanduser().resolve() if args.state else review_path.parent / "upload_state.json"
    registry = load_json(REGISTRY_PATH, default_registry())
    review_str = normalize_path(review_path)
    state_str = normalize_path(state_path)
    key = batch_key(review_str, args.source, args.prefix, tags, int(args.tid), state_str)
    batch_id = args.batch_id or key

    by_existing = {
        (
            clip.get("reviewPath"),
            int(clip.get("reviewIndex") or 0),
            clip.get("mediaPath") or "",
        ): clip_id
        for clip_id, clip in registry.get("clips", {}).items()
    }

    ids: List[int] = []
    for clip in clips:
        existing_id = by_existing.get((review_str, int(clip["reviewIndex"]), clip.get("mediaPath") or ""))
        if existing_id is not None:
            clip_id = int(existing_id)
            record = registry["clips"][str(clip_id)]
            record.update(
                {
                    "updatedAt": now_iso(),
                    "batchId": batch_id,
                    "reviewPath": review_str,
                    "statePath": state_str,
                    "source": args.source,
                    "prefix": args.prefix,
                    "tags": tags,
                    "tid": int(args.tid),
                    "title": clip["title"],
                    "start": clip["start"],
                    "duration": clip["duration"],
                    "mediaPath": clip.get("mediaPath") or "",
                    "coverPath": clip.get("coverPath") or record.get("coverPath") or "",
                }
            )
        else:
            clip_id = int(registry.get("nextClipId") or 1)
            registry["nextClipId"] = clip_id + 1
            registry.setdefault("clips", {})[str(clip_id)] = {
                "id": clip_id,
                "createdAt": now_iso(),
                "updatedAt": now_iso(),
                "status": "review",
                "batchId": batch_id,
                "reviewPath": review_str,
                "statePath": state_str,
                "source": args.source,
                "prefix": args.prefix,
                "tags": tags,
                "tid": int(args.tid),
                **clip,
            }
        ids.append(clip_id)

    registry.setdefault("batches", {})[batch_id] = {
        "id": batch_id,
        "label": args.label or args.source,
        "createdAt": registry.get("batches", {}).get(batch_id, {}).get("createdAt") or now_iso(),
        "updatedAt": now_iso(),
        "reviewPath": review_str,
        "statePath": state_str,
        "source": args.source,
        "prefix": args.prefix,
        "tags": tags,
        "tid": int(args.tid),
        "clipIds": ids,
    }
    save_json(REGISTRY_PATH, registry)
    print(f"[OK] imported {len(ids)} clips from {review_path}")
    print("IDs:", ",".join(str(i) for i in ids))
    return 0


def import_json(args: argparse.Namespace) -> int:
    """Import generated clip metadata without parsing the human review file."""
    try:
        from .clip_upload_json import import_json as run_import
    except ImportError:
        from clip_upload_json import import_json as run_import
    handle = acquire_queue_mutation_lock()
    try:
        return run_import(args, sys.modules[__name__])
    finally:
        release_queue_mutation_lock(handle)


def cut_candidates(args: argparse.Namespace) -> int:
    """Render selected held candidates, keeping their reserved upload IDs."""
    return clip_candidate_queue.cut_candidates(args, sys.modules[__name__])


def edit_candidate(args: argparse.Namespace) -> int:
    return clip_candidate_queue.edit_candidate(args, sys.modules[__name__])


def approve_rendered_review(args: argparse.Namespace) -> int:
    try:
        from .clip_rendered_review import approve_review
    except ImportError:
        from clip_rendered_review import approve_review
    return approve_review(args, sys.modules[__name__])


def clip_status_from_state(clip: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    state_path = Path(clip.get("statePath") or "")
    if not state_path.exists():
        return None
    state = load_json(state_path, {})
    idx = str(clip.get("reviewIndex"))
    done = state.get("done", {})
    if idx in done and state_record_matches_clip(clip, done[idx]):
        return {"status": "uploaded", **done[idx]}
    got_406 = state.get("got_406", {})
    if idx in got_406 and state_record_matches_clip(clip, got_406[idx]):
        return {"status": "needs_retry", **got_406[idx]}
    return None


def clear_mismatched_upload_state(clip: Dict[str, Any]) -> bool:
    if clip.get("status") not in ("uploaded", "needs_retry"):
        return False
    upload_state = clip.get("uploadState")
    if not isinstance(upload_state, dict):
        return False
    if upload_state.get("bvid") or upload_state.get("aid") or upload_state.get("cid"):
        return False
    state_title = upload_state.get("title")
    if not state_title or state_title == full_title(clip):
        return False
    clip["status"] = "review"
    clip.pop("uploadState", None)
    clip["updatedAt"] = now_iso()
    return True


def sync_clip_statuses(registry: Dict[str, Any], ids: Iterable[int]) -> None:
    for clip_id in ids:
        clip = registry.get("clips", {}).get(str(clip_id))
        if not clip:
            continue
        status = clip_status_from_state(clip)
        if not status:
            clear_mismatched_upload_state(clip)
            continue
        resolved_status = status.pop("status")
        clip["status"] = resolved_status
        clip["uploadState"] = status
        if resolved_status == "uploaded" and parse_utc_timestamp(
            status.get("submittedAt")
        ):
            clip["uploadedAt"] = parse_utc_timestamp(
                status["submittedAt"]
            ).isoformat()
        clip.pop("failureReason", None)
        clip["updatedAt"] = now_iso()


def list_clips(args: argparse.Namespace) -> int:
    registry = load_json(REGISTRY_PATH, default_registry())
    normalize_registry_media_paths(registry)
    ids = sorted(int(i) for i in registry.get("clips", {}).keys())
    sync_clip_statuses(registry, ids)
    save_json(REGISTRY_PATH, registry)
    for clip_id in ids:
        clip = registry["clips"][str(clip_id)]
        if args.status and clip.get("status") != args.status:
            continue
        title = f"{clip.get('prefix', '')}{clip.get('title', '')}"
        print(
            f"{clip_id:>4}  {clip.get('status', 'review'):<11} "
            f"#{clip.get('reviewIndex')} {title} | {clip.get('start')} {clip.get('duration')}"
        )
        if args.paths:
            print(f"      review: {clip.get('reviewPath')}")
            print(f"      media:  {clip.get('mediaPath')}")
    return 0


def show_clips(args: argparse.Namespace) -> int:
    ids = parse_int_list(args.ids)
    registry = load_json(REGISTRY_PATH, default_registry())
    normalize_registry_media_paths(registry)
    sync_clip_statuses(registry, ids)
    save_json(REGISTRY_PATH, registry)
    for clip_id in ids:
        clip = registry.get("clips", {}).get(str(clip_id))
        if not clip:
            print(f"[MISSING] {clip_id}")
            continue
        print(json.dumps(clip, ensure_ascii=False, indent=2))
    return 0


def enqueue(args: argparse.Namespace) -> int:
    ids = parse_int_list(args.ids)
    if not ids:
        print("[ERROR] --ids is empty", file=sys.stderr)
        return 2
    batch_size = int(getattr(args, "batch_size", DEFAULT_BATCH_SIZE))
    timeout_seconds = int(
        getattr(args, "timeout_seconds", DEFAULT_BATCH_TIMEOUT_SECONDS)
    )
    if batch_size < 1:
        print("[ERROR] --batch-size must be at least 1", file=sys.stderr)
        return 2
    if timeout_seconds < 60:
        print("[ERROR] --timeout-seconds must be at least 60", file=sys.stderr)
        return 2
    registry = load_json(REGISTRY_PATH, default_registry())
    missing = [clip_id for clip_id in ids if str(clip_id) not in registry.get("clips", {})]
    if missing:
        print(f"[ERROR] unknown clip ids: {missing}", file=sys.stderr)
        return 2
    held = [clip_id for clip_id in ids if registry["clips"][str(clip_id)].get("reviewPending")
            and not registry["clips"][str(clip_id)].get("pendingRebuild")]
    if held:
        print(f"[ERROR] IDs need review before upload (force cannot bypass): {held}. Use show/subtitles to inspect their reviewIssues.", file=sys.stderr)
        return 2
    sync_clip_statuses(registry, ids)
    already_uploaded = [clip_id for clip_id in ids if registry["clips"][str(clip_id)].get("status") == "uploaded"]
    revised_published = [clip_id for clip_id in ids if registry["clips"][str(clip_id)].get("subtitleRevisionKind") == "own_stream"
                         and clip_candidate_queue.is_published(registry["clips"][str(clip_id)])]
    if revised_published:
        print(f"[ERROR] revised published IDs require replacing their original submissions, not duplicate uploads: {revised_published}", file=sys.stderr)
        return 2
    if already_uploaded and not args.force:
        print(f"[ERROR] already uploaded ids (use --force to enqueue anyway): {already_uploaded}", file=sys.stderr)
        return 2
    if args.dry_run:
        for clip_id in ids:
            clip = registry["clips"][str(clip_id)]
            action = "cut_then_upload" if clip.get("pendingCut") or clip.get("pendingRebuild") else "upload"
            print(f"{clip_id}: [{action}] #{clip.get('reviewIndex')} {clip.get('prefix', '')}{clip.get('title', '')}")
        return 0

    with queue_transaction() as queue:
        # Re-read the registry under the same short lock used by every queue
        # writer. This also serializes two enqueue commands updating statuses.
        registry = load_json(REGISTRY_PATH, default_registry())
        missing = [
            clip_id
            for clip_id in ids
            if str(clip_id) not in registry.get("clips", {})
        ]
        if missing:
            print(f"[ERROR] unknown clip ids: {missing}", file=sys.stderr)
            return 2
        held = [clip_id for clip_id in ids if registry["clips"][str(clip_id)].get("reviewPending")
                and not registry["clips"][str(clip_id)].get("pendingRebuild")]
        if held:
            print(f"[ERROR] IDs need review before upload (force cannot bypass): {held}", file=sys.stderr)
            return 2
        sync_clip_statuses(registry, ids)
        revised_published = [clip_id for clip_id in ids if registry["clips"][str(clip_id)].get("subtitleRevisionKind") == "own_stream"
                             and clip_candidate_queue.is_published(registry["clips"][str(clip_id)])]
        if revised_published:
            print(f"[ERROR] revised published IDs cannot be re-enqueued: {revised_published}", file=sys.stderr)
            return 2
        already_uploaded = [
            clip_id
            for clip_id in ids
            if registry["clips"][str(clip_id)].get("status") == "uploaded"
        ]
        if already_uploaded and not args.force:
            print(
                "[ERROR] already uploaded ids (use --force to enqueue anyway): "
                f"{already_uploaded}",
                file=sys.stderr,
            )
            return 2

        active = clip_candidate_queue.active_ids(queue)
        ids = [clip_id for clip_id in ids if clip_id not in active]
        if not ids:
            print("[OK] requested IDs are already queued; no duplicate job created")
            return 0
        try:
            snapshots = clip_candidate_queue.approve_for_queue(sys.modules[__name__], registry, ids, args.note,
                getattr(args, "expected_candidate_drafts", None))
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            print(f"[ERROR] {error}", file=sys.stderr)
            return 2

        base_job_id = f"upload-{int(time.time())}"
        existing_job_ids = {
            str(existing.get("id") or "") for existing in queue.get("jobs", [])
        }
        job_id = base_job_id
        suffix = 2
        while job_id in existing_job_ids:
            job_id = f"{base_job_id}-{suffix}"
            suffix += 1
        job = {
            "id": job_id,
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
            "status": "pending",
            "clipIds": ids,
            "candidateSubtitles": snapshots,
            "delay": int(args.delay),
            "rateLimitWait": int(args.rate_limit_wait),
            "rateLimitRetries": int(args.rate_limit_retries),
            "batchSize": batch_size,
            "timeoutSeconds": timeout_seconds,
            "note": args.note or "",
            # ``--force`` explicitly authorizes re-submission, including when
            # Bilibili already has the same title.
            "allowDuplicateTitle": bool(args.force),
        }
        queue.setdefault("jobs", []).append(job)
        for clip_id in ids:
            clip = registry["clips"][str(clip_id)]
            if clip.get("status") != "uploaded" or args.force:
                clip["status"] = "queued"
                clip.pop("failureReason", None)
                clip["updatedAt"] = now_iso()
        save_json(REGISTRY_PATH, registry)
    print(f"[OK] queued {len(ids)} clips as {job['id']}: {','.join(str(i) for i in ids)}")
    return 0


def cancel_job(args: argparse.Namespace) -> int:
    """Cancel a waiting upload job and make its unfinished clips enqueueable again."""
    if not acquire_lock():
        print(
            "[ERROR] upload worker is running; stop it before cancelling a job",
            file=sys.stderr,
        )
        return 3

    try:
        queue = load_json(QUEUE_PATH, default_queue())
        job = next(
            (item for item in queue.get("jobs", []) if item.get("id") == args.job),
            None,
        )
        if job is None:
            print(f"[ERROR] unknown upload job: {args.job}", file=sys.stderr)
            return 2
        if job.get("status") == "cancelled":
            print(f"[OK] upload job already cancelled: {args.job}")
            return 0
        if job.get("status") not in ("pending", "retry_wait"):
            print(
                f"[ERROR] job {args.job} cannot be cancelled from status "
                f"{job.get('status')}",
                file=sys.stderr,
            )
            return 2

        ids = [int(clip_id) for clip_id in job.get("clipIds", [])]
        registry = load_json(REGISTRY_PATH, default_registry())
        missing = [
            clip_id
            for clip_id in ids
            if str(clip_id) not in registry.get("clips", {})
        ]
        if missing:
            print(f"[ERROR] missing registry ids: {missing}", file=sys.stderr)
            return 2

        sync_clip_statuses(registry, ids)
        other_active_ids = {
            int(clip_id)
            for other in queue.get("jobs", [])
            if other is not job
            and other.get("status") in ("pending", "retry_wait", "running")
            for clip_id in other.get("clipIds", [])
        }
        for clip_id in ids:
            clip = registry["clips"][str(clip_id)]
            if clip.get("status") == "uploaded" or clip_id in other_active_ids:
                continue
            clip["status"] = "review"
            clip.pop("failureReason", None)
            clip["updatedAt"] = now_iso()

        clear_job_retry_metadata(job)
        cancellation_note = str(args.note or "").strip()
        if cancellation_note:
            previous_note = str(job.get("note") or "").strip()
            job["note"] = "; ".join(
                note for note in (previous_note, cancellation_note) if note
            )
        cancelled_at = now_iso()
        mark_job(
            job,
            "cancelled",
            cancelledAt=cancelled_at,
            cancellationReason=cancellation_note,
            clipStatuses=clip_status_map(registry, ids),
        )
        save_json(REGISTRY_PATH, registry)
        commit_queue_snapshot(queue, job_ids=(job.get("id"),))
        print(
            f"[OK] cancelled {args.job}; reusable clip ids: "
            f"{','.join(str(clip_id) for clip_id in ids)}"
        )
        return 0
    finally:
        release_lock()


def resume_uploads(args: argparse.Namespace) -> int:
    """Clear a confirmed-stale 137022 cooldown and resume its waiting jobs."""
    if not acquire_lock():
        print(
            "[ERROR] upload worker is running; stop it before resuming uploads",
            file=sys.stderr,
        )
        return 3

    try:
        queue = load_json(QUEUE_PATH, default_queue())
        previous_cooldown = queue.get("submissionRateLimit")
        resumed_at = now_iso()
        resumed_jobs: List[str] = []
        for job in queue.get("jobs", []):
            is_rate_limit_wait = (
                job.get("status") == "retry_wait"
                and job.get("retryKind") == "bilibili_submission_rate_limit"
            )
            is_stale_resumed_pending = (
                job.get("status") == "pending"
                and is_bilibili_submission_rate_limit(job.get("lastOutput", ""))
            )
            if not (is_rate_limit_wait or is_stale_resumed_pending):
                continue
            previous_attempts = job.get("submissionRateLimitAttempts")
            previous_output = str(job.pop("lastOutput", "") or "")
            clear_job_retry_metadata(job)
            extra: Dict[str, Any] = {
                "resumedAt": resumed_at,
                "resumeReason": str(args.note or "").strip(),
            }
            if previous_attempts is not None:
                extra["previousSubmissionRateLimitAttempts"] = previous_attempts
            if previous_output:
                extra["previousRateLimitOutput"] = previous_output[-2000:]
            mark_job(job, "pending", **extra)
            resumed_jobs.append(str(job.get("id")))

        clear_submission_rate_limit(queue)
        queue["lastManualResume"] = {
            "at": resumed_at,
            "reason": str(args.note or "").strip(),
            "previousCooldown": previous_cooldown,
            "jobs": resumed_jobs,
        }
        commit_queue_snapshot(
            queue,
            job_ids=resumed_jobs,
            queue_fields=("submissionRateLimit", "lastManualResume"),
        )
        print(
            f"[OK] cleared Bilibili submission cooldown; resumed "
            f"{len(resumed_jobs)} jobs: {','.join(resumed_jobs) or '-'}"
        )
        return 0
    finally:
        release_lock()


def queue_status(args: argparse.Namespace) -> int:
    queue = load_json(QUEUE_PATH, default_queue())
    account_guard = queue.get("accountRollingUploadGuard")
    if isinstance(account_guard, dict):
        print(
            "[queue] account rolling upload guard "
            f"account={account_guard.get('accountId')} "
            f"count={account_guard.get('recentCount', 0)}/"
            f"{account_guard.get('limit', ACCOUNT_ROLLING_UPLOAD_LIMIT)} "
            f"window={account_guard.get('windowSeconds', ACCOUNT_ROLLING_WINDOW_SECONDS)}s "
            f"until={account_guard.get('blockedUntil', '-') }"
        )
    rate_limit = queue.get("submissionRateLimit")
    if isinstance(rate_limit, dict):
        print(
            "[queue] bilibili submission cooldown "
            f"code={rate_limit.get('code')} streak={rate_limit.get('streak')} "
            f"delay={rate_limit.get('delaySeconds')}s "
            f"until={rate_limit.get('cooldownUntil')}"
        )
    for job in queue.get("jobs", []):
        details = []
        if job.get("attempts") is not None:
            details.append(f"attempts={job.get('attempts')}")
        if job.get("submissionRateLimitAttempts") is not None:
            details.append(
                f"submitRateLimitAttempts={job.get('submissionRateLimitAttempts')}"
            )
        if job.get("batchSize") is not None:
            details.append(f"batchSize={job.get('batchSize')}")
        if job.get("timeoutSeconds") is not None:
            details.append(f"timeout={job.get('timeoutSeconds')}s")
        if job.get("retryAt"):
            details.append(f"retryAt={job.get('retryAt')}")
        print(
            f"{job.get('id')} {job.get('status')} ids={','.join(str(i) for i in job.get('clipIds', []))} "
            f"updated={job.get('updatedAt')} {' '.join(details)}".rstrip()
        )
        if job.get("error"):
            print(f"  error: {str(job['error'])[:1000]}")
        if job.get("renderFailures") and job.get("status") not in ("failed", "done"):
            for clip_id, reason in job["renderFailures"].items():
                print(f"  render failed ID {clip_id} (other IDs continue): {str(reason)[:1000]}")
        if args.verbose and job.get("lastOutput"):
            print(str(job["lastOutput"])[-2000:])
    return 0


def grouped_clips(registry: Dict[str, Any], ids: List[int]) -> List[List[Dict[str, Any]]]:
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for clip_id in ids:
        clip = registry["clips"][str(clip_id)]
        key = clip_batch_key(clip)
        groups.setdefault(key, []).append(clip)
    return list(groups.values())


def batch_size_for_job(job: Dict[str, Any]) -> int:
    try:
        configured = int(job.get("batchSize") or DEFAULT_BATCH_SIZE)
    except (TypeError, ValueError):
        configured = DEFAULT_BATCH_SIZE
    return max(1, configured)


def split_upload_groups(
    groups: List[List[Dict[str, Any]]], batch_size: int
) -> List[List[Dict[str, Any]]]:
    """Keep review groups ordered while bounding each uploader subprocess."""
    if batch_size < 1:
        raise ValueError("batch_size must be at least 1")
    chunks: List[List[Dict[str, Any]]] = []
    for group in groups:
        for offset in range(0, len(group), batch_size):
            chunks.append(group[offset : offset + batch_size])
    return chunks


def timeout_seconds_for_job(job: Dict[str, Any]) -> int:
    try:
        configured = int(job.get("timeoutSeconds") or DEFAULT_BATCH_TIMEOUT_SECONDS)
    except (TypeError, ValueError):
        configured = DEFAULT_BATCH_TIMEOUT_SECONDS
    return max(60, configured)


def run_batch(group: List[Dict[str, Any]], job: Dict[str, Any]) -> subprocess.CompletedProcess[str]:
    """Upload a group of clips.

    JSON-backed clips go through batch_upload.py using their manifest.
    Historical REVIEW.md clips keep using the Markdown compatibility path.
    Self-contained clips NOT in REVIEW.md (manually created) go through
    bilibili_upload.py individually, then their results are merged into the
    group's state file so sync_clip_statuses picks them up.
    """
    first = group[0]
    json_clips = [c for c in group if c.get("manifestPath")]
    review_clips = [c for c in group if not c.get("manifestPath") and _clip_in_review(c)]
    manual_clips = [c for c in group if not c.get("manifestPath") and not _clip_in_review(c)]

    outputs: List[str] = []
    returncode = 0
    submission_rate_limited = False
    timeout_seconds = timeout_seconds_for_job(job)

    # --- JSON-backed clips: use the structured manifest ---
    if json_clips:
        only = ",".join(str(int(clip["reviewIndex"])) for clip in json_clips)
        cmd = [
            sys.executable,
            "-u",
            str(PROJECT_ROOT / "src" / "scripts" / "batch_upload.py"),
            "--manifest",
            first["manifestPath"],
            "--source",
            first["source"],
            "--tags",
            ",".join(first["tags"]),
            "--prefix",
            first["prefix"],
            "--tid",
            str(int(first["tid"])),
            "--streamer-name",
            first.get("streamerName") or "",
            "--room-id",
            first.get("roomId") or "",
            "--delay",
            str(int(job.get("delay") or DEFAULT_DELAY)),
            "--only",
            only,
            "--state",
            first["statePath"],
            "--rate-limit-wait",
            str(int(job.get("rateLimitWait") or DEFAULT_RATE_LIMIT_WAIT)),
            "--rate-limit-retries",
            str(int(job.get("rateLimitRetries") or DEFAULT_RATE_LIMIT_RETRIES)),
        ]
        if job.get("allowDuplicateTitle"):
            cmd.append("--force")
        print("[worker] run:", " ".join(f'"{c}"' if " " in c else c for c in cmd), flush=True)
        try:
            cp = subprocess.run(
                cmd,
                cwd=str(PROJECT_ROOT),
                text=True,
                encoding="utf-8",
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=timeout_seconds,
                **hidden_subprocess_kwargs(),
            )
            output = cp.stdout or ""
            outputs.append(output)
            returncode = cp.returncode
            submission_rate_limited = is_bilibili_submission_rate_limit(output)
        except subprocess.TimeoutExpired as exc:
            output = exc.stdout or ""
            if isinstance(output, bytes):
                output = output.decode("utf-8", errors="replace")
            output += f"\n[worker] batch timed out after {timeout_seconds}s\n"
            outputs.append(output)
            returncode = 124

    # --- Historical REVIEW.md-backed clips: compatibility path ---
    if review_clips and returncode == 0 and not submission_rate_limited:
        only = ",".join(str(int(clip["reviewIndex"])) for clip in review_clips)
        cmd = [
            sys.executable,
            "-u",
            str(PROJECT_ROOT / "src" / "scripts" / "batch_upload.py"),
            "--review",
            first["reviewPath"],
            "--source",
            first["source"],
            "--tags",
            ",".join(first["tags"]),
            "--prefix",
            first["prefix"],
            "--tid",
            str(int(first["tid"])),
            "--delay",
            str(int(job.get("delay") or DEFAULT_DELAY)),
            "--only",
            only,
            "--state",
            first["statePath"],
            "--rate-limit-wait",
            str(int(job.get("rateLimitWait") or DEFAULT_RATE_LIMIT_WAIT)),
            "--rate-limit-retries",
            str(int(job.get("rateLimitRetries") or DEFAULT_RATE_LIMIT_RETRIES)),
        ]
        if job.get("allowDuplicateTitle"):
            cmd.append("--force")
        print("[worker] run:", " ".join(f'"{c}"' if " " in c else c for c in cmd), flush=True)
        try:
            cp = subprocess.run(
                cmd,
                cwd=str(PROJECT_ROOT),
                text=True,
                encoding="utf-8",
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=timeout_seconds,
                **hidden_subprocess_kwargs(),
            )
            output = cp.stdout or ""
            outputs.append(output)
            returncode = cp.returncode
            submission_rate_limited = is_bilibili_submission_rate_limit(output)
        except subprocess.TimeoutExpired as exc:
            output = exc.stdout or ""
            if isinstance(output, bytes):
                output = output.decode("utf-8", errors="replace")
            output += f"\n[worker] batch timed out after {timeout_seconds}s\n"
            outputs.append(output)
            returncode = 124

    # --- Manual clips: use bilibili_upload.py one by one ---
    if manual_clips and returncode == 0 and not submission_rate_limited:
        state_path = Path(first["statePath"])
        for clip in manual_clips:
            clip_id = clip["id"]
            title = f"{clip.get('prefix', '')}{clip.get('title', '')}"
            media = clip.get("mediaPath", "")
            cover = clip.get("coverPath", "")
            tags = ",".join(clip.get("tags", []))
            source_desc = clip.get("source", "")
            cmd2 = [
                sys.executable,
                "-u",
                str(PROJECT_ROOT / "src" / "scripts" / "bilibili_upload.py"),
                media,
                "--title", title,
                "--tags", tags,
                "--tid", str(int(clip.get("tid", 21))),
                "--source-desc", source_desc,
            ]
            if cover:
                cmd2 += ["--cover", cover]
            print(f"[worker] manual upload #{clip_id}:", " ".join(f'"{c}"' if " " in c else c for c in cmd2), flush=True)
            try:
                cp2 = subprocess.run(
                    cmd2,
                    cwd=str(PROJECT_ROOT),
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    timeout=timeout_seconds,
                    **hidden_subprocess_kwargs(),
                )
                out2 = cp2.stdout or ""
                outputs.append(out2)
                if is_bilibili_submission_rate_limit(out2):
                    submission_rate_limited = True
                    break
                if cp2.returncode != 0:
                    returncode = cp2.returncode
                    break
                # Write result into state file so sync_clip_statuses picks it up
                _write_manual_state(state_path, clip_id, clip, out2)
            except subprocess.TimeoutExpired as exc:
                output = exc.stdout or ""
                if isinstance(output, bytes):
                    output = output.decode("utf-8", errors="replace")
                outputs.append(output + f"\n[worker] manual upload timed out after {timeout_seconds}s\n")
                returncode = 124
                break

    combined = "\n".join(outputs)
    return subprocess.CompletedProcess(["mixed"], returncode, stdout=combined)


def _write_manual_state(state_path: Path, clip_id: Any, clip: Dict[str, Any], output: str) -> None:
    """Parse bilibili_upload.py output and write result into the state file.

    Uses reviewIndex as the key (same as batch_upload.py does) so that
    sync_clip_statuses -> clip_status_from_state can find it.
    """
    import re
    bvid_match = re.search(r"bvid:\s*(BV\w+)", output)
    aid_match = re.search(r"aid:\s*(\d+)", output)
    collection_match = re.search(r"合集:\s*(\d+)\s+\(([^)\r\n]+)\)", output)
    if not bvid_match:
        return
    bvid = bvid_match.group(1)
    aid = aid_match.group(1) if aid_match else ""
    title = f"{clip.get('prefix', '')}{clip.get('title', '')}"
    entry = {
        "title": title,
        "submittedTitle": title,
        "onlineTitle": title,
        "submittedAt": now_iso(),
        "bvid": bvid,
        "aid": int(aid) if aid.isdigit() else 0,
        "cid": 0,
        "source": "ok",
        "cover": clip.get("coverPath", ""),
        "reviewPath": clip.get("reviewPath", ""),
        "mediaPath": clip.get("mediaPath", ""),
    }
    if collection_match:
        entry["collectionSectionId"] = int(collection_match.group(1))
        entry["collectionStatus"] = collection_match.group(2).strip()
    try:
        state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {"done": {}, "got_406": {}}
    except (OSError, json.JSONDecodeError):
        state = {"done": {}, "got_406": {}}
    # Use reviewIndex as key (consistent with batch_upload.py state format)
    idx_key = str(clip.get("reviewIndex", clip_id))
    state.setdefault("done", {})[idx_key] = entry
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def is_bilibili_submission_rate_limit(output: str) -> bool:
    """Detect the creator submit endpoint's account-level rate-limit code."""
    return bool(
        re.search(
            rf"(?<!\d){BILIBILI_SUBMISSION_RATE_LIMIT_CODE}(?!\d)",
            str(output or ""),
        )
    )


def submission_rate_limit_delay_seconds(streak: int) -> int:
    return min(
        SUBMISSION_RATE_LIMIT_BASE_DELAY_SECONDS * (2 ** max(int(streak) - 1, 0)),
        SUBMISSION_RATE_LIMIT_MAX_DELAY_SECONDS,
    )


def set_submission_rate_limit_cooldown(
    queue: Dict[str, Any],
    job_id: Any,
    streak: int,
    now: Optional[dt.datetime] = None,
) -> tuple[dt.datetime, int]:
    current = now or dt.datetime.now(dt.timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=dt.timezone.utc)
    current = current.astimezone(dt.timezone.utc)
    delay_seconds = submission_rate_limit_delay_seconds(streak)
    cooldown_until = current + dt.timedelta(seconds=delay_seconds)
    queue["submissionRateLimit"] = {
        "code": BILIBILI_SUBMISSION_RATE_LIMIT_CODE,
        "streak": int(streak),
        "delaySeconds": delay_seconds,
        "cooldownUntil": cooldown_until.isoformat(),
        "updatedAt": current.isoformat(),
        "jobId": job_id,
    }
    return cooldown_until, delay_seconds


def submission_rate_limit_cooldown_active(
    queue: Dict[str, Any], now: Optional[dt.datetime] = None
) -> bool:
    state = queue.get("submissionRateLimit")
    if not isinstance(state, dict):
        return False
    cooldown_until = parse_utc_timestamp(state.get("cooldownUntil"))
    if cooldown_until is None:
        return False
    current = now or dt.datetime.now(dt.timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=dt.timezone.utc)
    return cooldown_until > current.astimezone(dt.timezone.utc)


def clear_submission_rate_limit(queue: Dict[str, Any]) -> None:
    queue.pop("submissionRateLimit", None)


def next_pending_job(
    queue: Dict[str, Any],
    *,
    ignore_account_upload_limit: bool = False,
) -> Optional[Dict[str, Any]]:
    now = dt.datetime.now(dt.timezone.utc)
    if submission_rate_limit_cooldown_active(queue, now):
        return None
    if not ignore_account_upload_limit and account_upload_limit_active(queue, now):
        return None
    for job in queue.get("jobs", []):
        if job.get("status") == "pending":
            return job
        if job.get("status") == "retry_wait":
            retry_at = parse_utc_timestamp(job.get("retryAt"))
            if retry_at is not None and retry_at <= now:
                return job
            if job.get("retryAt") and retry_at is None:
                # A malformed timestamp must not leave an otherwise retryable
                # upload blocked forever.
                return job
    return None


def mark_job(job: Dict[str, Any], status: str, **extra: Any) -> None:
    job["status"] = status
    job["updatedAt"] = now_iso()
    job.update(extra)


def clip_status_map(registry: Dict[str, Any], ids: Iterable[int]) -> Dict[int, str]:
    return {
        int(clip_id): registry["clips"][str(clip_id)].get("status", "review")
        for clip_id in ids
        if str(clip_id) in registry.get("clips", {})
    }


def set_unfinished_clip_statuses(
    registry: Dict[str, Any],
    ids: Iterable[int],
    status: str,
    reason: str = "",
) -> None:
    """Keep registry state honest while a job waits or reaches a terminal error."""
    for clip_id in ids:
        clip = registry.get("clips", {}).get(str(clip_id))
        if not clip or clip.get("status") == "uploaded":
            continue
        clip["status"] = status
        if reason:
            clip["failureReason"] = reason
        else:
            clip.pop("failureReason", None)
        clip["updatedAt"] = now_iso()


def has_terminal_upload_error(output: str) -> bool:
    return bool(terminal_upload_error_reason(output))


def terminal_upload_error_reason(output: str) -> str:
    """Return a reason for an error that cannot succeed by retrying unchanged.

    Summary lines with a zero count are informational.  Only a positive
    count or an explicit per-clip error should make a job terminal.
    """
    text = str(output or "")
    lowered = text.lower()
    for marker in TERMINAL_UPLOAD_ERROR_MARKERS:
        if marker.lower() in lowered:
            return f"deterministic uploader error: {marker}"
    if re.search(r"文件缺失:\s*[1-9]\d*", text):
        return "deterministic uploader error: 文件缺失"
    if re.search(
        r"(?:同标题冲突(?:\(待核对\))?|标题冲突)\s*[:：]\s*(?:[1-9]\d*|BV\w+)",
        text,
    ) or re.search(r"\[\s*CONFLICT\s*\]|上传前发现同标题已存在", text, re.IGNORECASE):
        return "deterministic uploader error: 同标题冲突"
    return ""


def format_upload_failure(returncode: int, output: str) -> str:
    detail = str(output or "").strip()
    if len(detail) > 2000:
        detail = detail[-2000:]
    prefix = f"upload subprocess exited with code {returncode}"
    return f"{prefix}: {detail}" if detail else prefix


def schedule_retry_or_block(
    registry: Dict[str, Any],
    job: Dict[str, Any],
    ids: Iterable[int],
    output: str,
    reason: str,
) -> str:
    """Retry transient failures instead of losing partially completed jobs."""
    attempt = int(job.get("attempts") or 0) + 1
    last_output = str(output or "")[-12000:]
    ids_list = [int(clip_id) for clip_id in ids]
    if attempt >= MAX_AUTOMATIC_JOB_RETRIES:
        set_unfinished_clip_statuses(registry, ids_list, "failed", reason)
        clear_job_retry_metadata(job)
        mark_job(
            job,
            "blocked",
            attempts=attempt,
            clipStatuses=clip_status_map(registry, ids_list),
            lastOutput=last_output,
            error=f"automatic retry limit reached: {reason}",
        )
        return "blocked"

    set_unfinished_clip_statuses(registry, ids_list, "queued")
    retry_at = dt.datetime.now(dt.timezone.utc) + dt.timedelta(
        seconds=retry_delay_seconds(attempt)
    )
    mark_job(
        job,
        "retry_wait",
        attempts=attempt,
        retryAt=retry_at.isoformat(),
        clipStatuses=clip_status_map(registry, ids_list),
        lastOutput=last_output,
        error=reason,
    )
    return "retry_wait"


def schedule_submission_rate_limit_retry(
    registry: Dict[str, Any],
    queue: Dict[str, Any],
    job: Dict[str, Any],
    ids: Iterable[int],
    output: str,
) -> str:
    """Apply an account-wide cooldown for Bilibili submit error 137022."""
    previous = queue.get("submissionRateLimit")
    previous_streak = 0
    if isinstance(previous, dict):
        try:
            previous_streak = int(previous.get("streak") or 0)
        except (TypeError, ValueError):
            previous_streak = 0
    streak = previous_streak + 1
    retry_at, delay_seconds = set_submission_rate_limit_cooldown(
        queue,
        job.get("id"),
        streak,
    )
    ids_list = [int(clip_id) for clip_id in ids]
    attempt = int(job.get("attempts") or 0) + 1
    submit_attempt = int(job.get("submissionRateLimitAttempts") or 0) + 1
    reason = (
        f"Bilibili submission rate limited (code {BILIBILI_SUBMISSION_RATE_LIMIT_CODE}); "
        f"retry in {delay_seconds // 60} minutes"
    )

    set_unfinished_clip_statuses(registry, ids_list, "queued")
    mark_job(
        job,
        "retry_wait",
        attempts=attempt,
        submissionRateLimitAttempts=submit_attempt,
        retryAt=retry_at.isoformat(),
        retryKind="bilibili_submission_rate_limit",
        clipStatuses=clip_status_map(registry, ids_list),
        lastOutput=str(output or "")[-12000:],
        error=reason,
    )
    return "retry_wait"


def clip_upload_snapshot(
    registry: Dict[str, Any], ids: Iterable[int]
) -> Dict[int, Dict[str, Any]]:
    snapshot: Dict[int, Dict[str, Any]] = {}
    for clip_id in ids:
        clip = registry.get("clips", {}).get(str(clip_id)) or {}
        upload_state = clip.get("uploadState") or {}
        snapshot[int(clip_id)] = {
            "status": clip.get("status"),
            "bvid": upload_state.get("bvid") or "",
            "submittedAt": upload_state.get("submittedAt")
            or clip.get("uploadedAt")
            or "",
        }
    return snapshot


def record_successful_upload_events(
    queue: Dict[str, Any],
    registry: Dict[str, Any],
    ids: Iterable[int],
    job_id: Any,
    before: Dict[int, Dict[str, Any]],
    now: Optional[dt.datetime] = None,
) -> List[int]:
    """Persist newly observed successes immediately after each uploader batch."""
    current = normalize_utc_now(now)
    account_id, _, _ = configured_upload_account()
    state = ensure_account_upload_guard(queue, account_id)
    incoming: List[Dict[str, Any]] = []
    recorded_ids: List[int] = []
    for raw_clip_id in ids:
        clip_id = int(raw_clip_id)
        clip = registry.get("clips", {}).get(str(clip_id)) or {}
        if clip.get("status") != "uploaded":
            continue
        upload_state = clip.get("uploadState") or {}
        previous = before.get(clip_id) or {}
        bvid = str(upload_state.get("bvid") or "")
        submitted_at = upload_state.get("submittedAt") or clip.get("uploadedAt")
        changed = (
            previous.get("status") != "uploaded"
            or (bvid and bvid != previous.get("bvid"))
            or (
                submitted_at
                and str(submitted_at) != str(previous.get("submittedAt") or "")
            )
        )
        if not changed:
            continue
        parsed_submitted_at = parse_utc_timestamp(submitted_at) or current
        clip["uploadedAt"] = parsed_submitted_at.isoformat()
        incoming.append(
            {
                "at": parsed_submitted_at.isoformat(),
                "bvid": bvid,
                "aid": upload_state.get("aid"),
                "title": upload_state.get("onlineTitle")
                or upload_state.get("title")
                or full_title(clip),
                "source": "upload_worker",
                "clipId": clip_id,
                "jobId": str(job_id or ""),
            }
        )
        recorded_ids.append(clip_id)
    if incoming:
        state["events"] = merge_rolling_upload_events(
            state.get("events") or [], incoming, current
        )
    recalculate_account_upload_guard(state, current)
    return recorded_ids


def send_account_upload_limit_notification(
    state: Dict[str, Any],
    job: Dict[str, Any],
    next_clip_id: Optional[int],
    retry_at: dt.datetime,
) -> bool:
    """Notify WeChat Work when the local rolling-window guard pauses uploads."""
    _, _, webhook_url = configured_upload_account()
    if not webhook_url:
        print(
            "[worker] WeChat Work webhook is not configured; upload-limit alert skipped",
            file=sys.stderr,
            flush=True,
        )
        return False

    next_clip_text = str(next_clip_id) if next_clip_id is not None else "-"
    content = "\n".join(
        (
            "## B站投稿频控保护",
            (
                f"> 账号 `{state.get('accountId', '-')}` 在滚动24小时内已有 "
                f"**{state.get('recentCount', 0)}** 条投稿，达到保护上限 "
                f"**{ACCOUNT_ROLLING_UPLOAD_LIMIT}** 条，队列已暂停。"
            ),
            (
                "> 下一个视频预计于 "
                f'<font color="info">{format_china_timestamp(retry_at)}</font> '
                "开始传输（北京时间）。"
            ),
            f"> 待传短ID：`{next_clip_text}`；队列作业：`{job.get('id', '-')}`",
        )
    )
    response = requests.post(
        webhook_url,
        json={"msgtype": "markdown", "markdown": {"content": content}},
        timeout=10,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("errcode") != 0:
        raise RuntimeError(
            f"WeChat Work returned {payload.get('errcode')}: "
            f"{payload.get('errmsg', '')}"
        )
    return True


def schedule_account_upload_limit_retry(
    registry: Dict[str, Any],
    queue: Dict[str, Any],
    job: Dict[str, Any],
    ids: Iterable[int],
    state: Dict[str, Any],
    now: Optional[dt.datetime] = None,
) -> str:
    current = normalize_utc_now(now)
    recalculate_account_upload_guard(state, current)
    retry_at = parse_utc_timestamp(state.get("blockedUntil"))
    if retry_at is None:
        retry_at = current + dt.timedelta(seconds=ACCOUNT_ARCHIVE_REFRESH_SECONDS)
        state["blockedUntil"] = retry_at.isoformat()

    ids_list = [int(clip_id) for clip_id in ids]
    pending_ids = [
        clip_id
        for clip_id in ids_list
        if (registry.get("clips", {}).get(str(clip_id)) or {}).get("status")
        != "uploaded"
    ]
    next_clip_id = pending_ids[0] if pending_ids else None
    set_unfinished_clip_statuses(registry, pending_ids, "queued")
    clear_job_retry_metadata(job)
    reason = (
        f"account rolling upload limit reached "
        f"({state.get('recentCount', 0)}/{ACCOUNT_ROLLING_UPLOAD_LIMIT} in 24h); "
        f"next upload at {format_china_timestamp(retry_at)} Asia/Shanghai"
    )
    mark_job(
        job,
        "retry_wait",
        retryAt=retry_at.isoformat(),
        retryKind="account_rolling_upload_limit",
        accountUploadLimitWaits=int(job.get("accountUploadLimitWaits") or 0) + 1,
        clipStatuses=clip_status_map(registry, ids_list),
        error=reason,
    )
    state["blockedJobId"] = str(job.get("id") or "")
    state["nextClipId"] = next_clip_id

    notification_key = (
        f"{state.get('accountId', '')}:{retry_at.isoformat()}:"
        f"{job.get('id', '')}:{next_clip_id}"
    )
    if state.get("lastNotificationKey") != notification_key:
        state["lastNotificationAttemptAt"] = current.isoformat()
        try:
            sent = send_account_upload_limit_notification(
                state, job, next_clip_id, retry_at
            )
            state["lastNotificationStatus"] = "sent" if sent else "not_configured"
            if sent:
                state["lastNotificationAt"] = now_iso()
        except Exception as error:
            state["lastNotificationStatus"] = "failed"
            state["lastNotificationError"] = str(error)[:500]
            print(
                f"[worker] failed to send rolling upload-limit alert: {error}",
                file=sys.stderr,
                flush=True,
            )
        state["lastNotificationKey"] = notification_key

    print(
        "[worker] rolling 24h upload limit reached: "
        f"{state.get('recentCount', 0)}/{ACCOUNT_ROLLING_UPLOAD_LIMIT}; "
        f"next upload at {format_china_timestamp(retry_at)} Asia/Shanghai",
        flush=True,
    )
    return "retry_wait"


def clear_job_retry_metadata(job: Dict[str, Any]) -> None:
    for key in (
        "retryAt",
        "error",
        "retryKind",
        "submissionRateLimitAttempts",
    ):
        job.pop(key, None)


def pid_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        if os.name == "nt":
            result = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                **hidden_subprocess_kwargs(),
            )
            return str(pid) in (result.stdout or "")
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def acquire_lock(stale_seconds: int = 12 * 60 * 60) -> bool:
    global LOCK_OWNER_TOKEN
    ensure_runtime_dir()
    owner_token = secrets.token_hex(16)
    lock_payload = json.dumps({"pid": os.getpid(), "time": time.time(), "token": owner_token})
    while True:
        try:
            fd = os.open(str(LOCK_PATH), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(lock_payload)
            LOCK_OWNER_TOKEN = owner_token
            return True
        except FileExistsError:
            pass

        try:
            existing = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
            pid = int(existing.get("pid") or 0)
            if pid and not pid_is_alive(pid):
                LOCK_PATH.unlink()
                continue
            age = time.time() - float(existing.get("time") or 0)
            if age < stale_seconds:
                print(f"[worker] another worker lock exists: {LOCK_PATH}", file=sys.stderr)
                return False
            LOCK_PATH.unlink()
        except Exception:
            try:
                LOCK_PATH.unlink()
            except OSError:
                return False


def release_lock() -> None:
    """Release only the lock acquired by this worker.

    A stale worker must never remove a newer worker's lock after its own lock
    was reclaimed.  The random token also protects against PID reuse.
    """
    try:
        if LOCK_PATH.exists():
            existing = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
            if (
                int(existing.get("pid") or 0) != os.getpid()
                or existing.get("token") != LOCK_OWNER_TOKEN
            ):
                return
            LOCK_PATH.unlink()
    except (OSError, ValueError, json.JSONDecodeError):
        pass


def clip_is_self_contained(clip: Dict[str, Any]) -> bool:
    """Check if a registry clip has all fields needed to upload without REVIEW.md."""
    return all(
        clip.get(k)
        for k in ("title", "mediaPath", "tags", "prefix", "tid", "source")
    ) and bool(clip.get("mediaPath"))


def validate_groups(groups: List[List[Dict[str, Any]]]) -> List[str]:
    """Return registry/review mismatches before invoking the uploader.

    ``batch_upload.py --only`` exits successfully when none of the requested
    review rows exist.  Without this check the queue labelled such a job as
    blocked and left the clip permanently in ``uploading``.

    JSON-backed clips are self-contained and use their manifest. Historical
    REVIEW.md records still need the Markdown row check; manually created
    records without either source continue through the single-upload path.
    """
    errors: List[str] = validate_registry_qa(groups)
    for group in groups:
        errors.extend(f"candidate {clip.get('id')} needs cutting first" for clip in group if clip.get("pendingCut"))
        json_clips = [c for c in group if c.get("manifestPath")]
        legacy_clips = [c for c in group if not c.get("manifestPath")]
        if json_clips and not legacy_clips:
            continue

        review_clips = [c for c in legacy_clips if not clip_is_self_contained(c) or _clip_in_review(c)]
        manual_clips = [c for c in legacy_clips if clip_is_self_contained(c) and not _clip_in_review(c)]
        if not review_clips and not manual_clips:
            continue
        if not review_clips:
            continue
        review_path = Path(review_clips[0].get("reviewPath") or group[0].get("reviewPath") or "")
        try:
            available = {int(item["reviewIndex"]) for item in parse_review(review_path)}
        except (OSError, UnicodeError) as exc:
            if manual_clips and not review_clips:
                continue
            errors.append(f"cannot read REVIEW.md {review_path}: {exc}")
            continue
        requested = [int(c["reviewIndex"]) for c in review_clips]
        missing = sorted(set(requested) - available)
        if missing:
            errors.append(f"REVIEW.md {review_path} has no rows: {missing}")
    return errors


def _clip_in_review(clip: Dict[str, Any]) -> bool:
    """Best-effort check: is this clip's reviewIndex present in its REVIEW.md?"""
    if clip.get("manifestPath"):
        return False
    review_path = Path(clip.get("reviewPath", ""))
    if not review_path.exists():
        return False
    try:
        available = {int(item["reviewIndex"]) for item in parse_review(review_path)}
        return int(clip.get("reviewIndex", -1)) in available
    except (OSError, UnicodeError, ValueError, TypeError):
        return False


def retry_delay_seconds(attempt: int) -> int:
    """Back off retries after Bilibili/network transient stops."""
    return min(DEFAULT_RETRY_DELAY_SECONDS * (2 ** max(attempt - 1, 0)), 2 * 60 * 60)


def recover_interrupted_jobs() -> bool:
    """Requeue work left in ``running`` when the worker was interrupted.

    A job marked ``blocked`` is now a deliberate retry-limit terminal state;
    restarting the worker must not silently bypass that limit.  Re-running a
    recovered job is idempotent because the uploader checks both its state
    file and the live member archive before submitting anything.
    """
    registry = load_json(REGISTRY_PATH, default_registry())
    queue = load_json(QUEUE_PATH, default_queue())
    changed = normalize_registry_media_paths(registry)
    interrupted_rate_limit_job_ids = set()
    for job in queue.get("jobs", []):
        job_status = job.get("status")
        if job_status not in ("running", "failed", "blocked"):
            continue
        if job_status == "running" and is_bilibili_submission_rate_limit(
            job.get("lastOutput", "")
        ):
            interrupted_rate_limit_job_ids.add(str(job.get("id")))
        ids = [int(i) for i in job.get("clipIds", [])]
        known_ids = [clip_id for clip_id in ids if str(clip_id) in registry.get("clips", {})]
        if not known_ids:
            if job_status == "running":
                mark_job(job, "failed", error=f"missing registry ids: {ids}")
                changed = True
            continue
        sync_clip_statuses(registry, known_ids)
        if all(registry["clips"][str(clip_id)].get("status") == "uploaded" for clip_id in known_ids):
            clear_job_retry_metadata(job)
            mark_job(
                job,
                "done",
                result="all ids already uploaded after recovery",
                clipStatuses=clip_status_map(registry, known_ids),
            )
        elif job_status != "running":
            # Historical failures remain manual-review candidates.  Only
            # close them when every requested clip is independently confirmed
            # uploaded; never revive a failed job into an automatic retry.
            if job.pop("retryAt", None) is not None:
                changed = True
            continue
        else:
            set_unfinished_clip_statuses(
                registry,
                [i for i in known_ids if str(i) not in job.get("renderFailures", {})],
                "queued",
                reason="",
            )
            mark_job(
                job,
                "pending",
                recoveredAt=now_iso(),
                recoveryReason="worker interrupted while upload was running",
                clipStatuses=clip_status_map(registry, known_ids),
            )
        changed = True

    if not isinstance(queue.get("submissionRateLimit"), dict):
        for job in reversed(queue.get("jobs", [])):
            recoverable_retry = (
                job.get("status") == "retry_wait"
                and job.get("retryKind") == "bilibili_submission_rate_limit"
            )
            recoverable_interruption = str(job.get("id")) in (
                interrupted_rate_limit_job_ids
            )
            if not (recoverable_retry or recoverable_interruption):
                continue
            if not is_bilibili_submission_rate_limit(job.get("lastOutput", "")):
                continue
            _, delay_seconds = set_submission_rate_limit_cooldown(
                queue,
                job.get("id"),
                1,
            )
            job["rateLimitRecoveredAt"] = now_iso()
            changed = True
            print(
                "[worker] recovered Bilibili submission cooldown from queued output: "
                f"{delay_seconds // 60} minutes",
                flush=True,
            )
            break
    if changed:
        save_json(REGISTRY_PATH, registry)
        commit_queue_snapshot(
            queue,
            job_ids=(job.get("id") for job in queue.get("jobs", [])),
            queue_fields=("submissionRateLimit",),
        )
    return changed


def run_one_job() -> bool:
    registry = load_json(REGISTRY_PATH, default_registry())
    queue = load_json(QUEUE_PATH, default_queue())
    if normalize_registry_media_paths(registry):
        save_json(REGISTRY_PATH, registry)

    account_guard, guard_changed = refresh_account_upload_guard(queue, registry)
    if guard_changed:
        queue = commit_queue_snapshot(
            queue, queue_fields=("accountRollingUploadGuard",)
        )
        account_guard = queue["accountRollingUploadGuard"]

    # Keep the Bilibili 137022 cooldown authoritative.  Ignore only the local
    # rolling guard here so its next waiting job can be annotated and notified.
    job = next_pending_job(queue, ignore_account_upload_limit=True)
    if not job:
        return False
    job_id = job.get("id")

    ids = [int(i) for i in job.get("clipIds", [])]
    missing = [clip_id for clip_id in ids if str(clip_id) not in registry.get("clips", {})]
    if missing:
        reason = f"missing registry ids: {missing}"
        known_ids = [clip_id for clip_id in ids if str(clip_id) in registry.get("clips", {})]
        set_unfinished_clip_statuses(registry, known_ids, "failed", reason)
        clear_job_retry_metadata(job)
        mark_job(job, "failed", clipStatuses=clip_status_map(registry, known_ids), error=reason)
        save_json(REGISTRY_PATH, registry)
        commit_queue_snapshot(queue, job_ids=(job_id,))
        return True

    ids = clip_candidate_queue.uploadable_job_ids(job)
    sync_clip_statuses(registry, ids)
    force_resubmit = bool(job.get("allowDuplicateTitle"))
    pending_ids = [
        clip_id
        for clip_id in ids
        if force_resubmit or registry["clips"][str(clip_id)].get("status") != "uploaded"
    ]
    if not pending_ids:
        clip_candidate_queue.finish_job(sys.modules[__name__], registry, job, result="all eligible ids already uploaded")
        save_json(REGISTRY_PATH, registry)
        commit_queue_snapshot(queue, job_ids=(job_id,))
        return True

    if account_upload_limit_active(queue):
        schedule_account_upload_limit_retry(
            registry, queue, job, ids, account_guard
        )
        save_json(REGISTRY_PATH, registry)
        commit_queue_snapshot(
            queue,
            job_ids=(job_id,),
            queue_fields=("accountRollingUploadGuard",),
        )
        return True

    prepared = clip_candidate_queue.render_for_job(sys.modules[__name__], registry, queue, job, pending_ids)
    if prepared is None:
        return True
    registry, queue = prepared
    job = find_queue_job(queue, job_id) or job
    ids = clip_candidate_queue.uploadable_job_ids(job)
    pending_ids = [i for i in pending_ids if i in ids]
    groups = grouped_clips(registry, pending_ids)
    validation_errors = validate_groups(groups)
    if validation_errors:
        reason = "; ".join(validation_errors)
        set_unfinished_clip_statuses(registry, pending_ids, "failed", reason)
        clear_job_retry_metadata(job)
        mark_job(job, "failed", clipStatuses=clip_status_map(registry, ids), error=reason)
        save_json(REGISTRY_PATH, registry)
        commit_queue_snapshot(queue, job_ids=(job_id,))
        print(f"[worker] invalid upload job: {reason}", file=sys.stderr)
        return True

    mark_job(job, "running", phase="uploading", startedAt=now_iso())
    for clip_id in pending_ids:
        registry["clips"][str(clip_id)]["status"] = "uploading"
        registry["clips"][str(clip_id)]["updatedAt"] = now_iso()
    save_json(REGISTRY_PATH, registry)
    queue = commit_queue_snapshot(queue, job_ids=(job_id,))
    job = find_queue_job(queue, job_id) or job

    all_outputs: List[str] = []
    failed = False
    submission_rate_limited = False
    account_upload_limited = False
    made_upload_progress = False
    last_returncode = 0
    upload_groups = split_upload_groups(groups, batch_size_for_job(job))
    group_index = 0
    while group_index < len(upload_groups):
        # Refresh before every subprocess so uploads made outside this queue
        # are included before another local slot is consumed.
        account_guard, guard_changed = refresh_account_upload_guard(
            queue,
            registry,
            force_remote=True,
        )
        if guard_changed:
            queue = commit_queue_snapshot(
                queue, queue_fields=("accountRollingUploadGuard",)
            )
            account_guard = queue["accountRollingUploadGuard"]
            job = find_queue_job(queue, job_id) or job
        available_slots = account_upload_available_slots(account_guard)
        if available_slots <= 0:
            account_upload_limited = True
            break

        group = upload_groups[group_index]
        if len(group) > available_slots:
            upload_groups[group_index] = group[:available_slots]
            upload_groups.insert(group_index + 1, group[available_slots:])
            group = upload_groups[group_index]

        group_ids = [int(clip["id"]) for clip in group]
        before_upload = clip_upload_snapshot(registry, group_ids)
        cp = run_batch(group, job)
        last_returncode = cp.returncode
        output = cp.stdout or ""
        all_outputs.append(output[-8000:])
        print(output, end="", flush=True)

        # batch_upload.py persists each success immediately.  Sync and ledger
        # those successes even when a later item in the same batch failed.
        registry = load_json(REGISTRY_PATH, default_registry())
        sync_clip_statuses(registry, group_ids)
        recorded_ids = record_successful_upload_events(
            queue,
            registry,
            group_ids,
            job.get("id"),
            before_upload,
        )
        if recorded_ids:
            made_upload_progress = True
            clear_submission_rate_limit(queue)
        save_json(REGISTRY_PATH, registry)
        queue = commit_queue_snapshot(
            queue,
            queue_fields=(
                "accountRollingUploadGuard",
                "submissionRateLimit",
            ),
        )
        account_guard = queue["accountRollingUploadGuard"]
        job = find_queue_job(queue, job_id) or job

        if account_upload_available_slots(account_guard) <= 0:
            account_upload_limited = True
        if is_bilibili_submission_rate_limit(output):
            submission_rate_limited = True
            break
        if cp.returncode != 0:
            failed = True
            break
        if account_upload_limited:
            break
        group_index += 1

    registry = load_json(REGISTRY_PATH, default_registry())
    sync_clip_statuses(registry, ids)
    save_json(REGISTRY_PATH, registry)
    queue = load_json(QUEUE_PATH, default_queue())
    current = find_queue_job(queue, job_id) or job
    statuses = {clip_id: registry["clips"][str(clip_id)].get("status") for clip_id in ids}
    last_output = "\n".join(all_outputs)[-12000:]
    pending_after_run = [clip_id for clip_id, status in statuses.items() if status != "uploaded"]
    if made_upload_progress:
        clear_submission_rate_limit(queue)

    # A subprocess can exit non-zero after it has already persisted the final
    # successful result (for example while attaching a collection).  The
    # registry state is authoritative, so never turn that into a failed job.
    if not pending_after_run:
        clip_candidate_queue.finish_job(sys.modules[__name__], registry, current, lastOutput=last_output)
    else:
        terminal_reason = terminal_upload_error_reason(last_output)
        if terminal_reason:
            reason = f"{terminal_reason}; subprocess exited with code {last_returncode}"
            set_unfinished_clip_statuses(registry, pending_after_run, "failed", reason)
            clear_job_retry_metadata(current)
            mark_job(
                current,
                "failed",
                clipStatuses=clip_status_map(registry, ids),
                lastOutput=last_output,
                error=reason,
            )
        elif account_upload_limited:
            account_guard = ensure_account_upload_guard(
                queue, configured_upload_account()[0]
            )
            schedule_account_upload_limit_retry(
                registry,
                queue,
                current,
                ids,
                account_guard,
            )
        elif submission_rate_limited:
            schedule_submission_rate_limit_retry(
                registry,
                queue,
                current,
                ids,
                last_output,
            )
        elif failed:
            schedule_retry_or_block(
                registry,
                current,
                ids,
                last_output,
                format_upload_failure(last_returncode, last_output),
            )
        else:
            schedule_retry_or_block(
                registry,
                current,
                ids,
                last_output,
                "uploader completed without recording all requested clips",
            )
    save_json(REGISTRY_PATH, registry)
    commit_queue_snapshot(
        queue,
        job_ids=(job_id,),
        queue_fields=("accountRollingUploadGuard", "submissionRateLimit"),
    )
    return True


def worker(args: argparse.Namespace) -> int:
    if not acquire_lock():
        return 3
    try:
        recover_interrupted_jobs()
        while True:
            did_work = run_one_job()
            if not args.loop:
                return 0
            time.sleep(int(args.interval if did_work else args.idle_interval))
    finally:
        release_lock()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage short-id reviewed clip uploads")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("import-review", help="Import a REVIEW.md into the short-id registry")
    p.add_argument("--review", required=True)
    p.add_argument("--source", required=True)
    p.add_argument("--tags", default="小岁,虚拟主播,直播切片,岁AI切片")
    p.add_argument("--prefix", default="【小岁】")
    p.add_argument("--tid", type=int, default=21)
    p.add_argument("--state", default=None)
    p.add_argument("--label", default="")
    p.add_argument("--batch-id", default="")
    p.set_defaults(func=import_review)

    p = sub.add_parser("import-json", help="Import a generated clip JSON manifest into the short-id registry")
    p.add_argument("--manifest", required=True, help="批次 manifest 或单个切片 metadata JSON")
    p.add_argument("--review", default=None, help="仅作为人工审核链接保存，不参与机器解析")
    p.add_argument("--source", default="")
    p.add_argument("--tags", default="")
    p.add_argument("--prefix", default="")
    p.add_argument("--tid", type=int, default=None)
    p.add_argument("--state", default=None)
    p.add_argument("--label", default="")
    p.add_argument("--batch-id", default="")
    p.add_argument("--include-pending", action="store_true", help="Reserve IDs for persisted, unapproved metadata; never authorizes upload")
    p.set_defaults(func=import_json)

    p = sub.add_parser("list", help="List registered clips")
    p.add_argument("--status", default="")
    p.add_argument("--paths", action="store_true")
    p.set_defaults(func=list_clips)

    p = sub.add_parser("show", help="Show clip records as JSON")
    p.add_argument("ids")
    p.set_defaults(func=show_clips)

    p = sub.add_parser("subtitles", help="Show or prepare the editable candidate SRT by numeric ID")
    p.add_argument("--id", required=True, type=int)
    p.set_defaults(func=edit_candidate)

    p = sub.add_parser("correct", help="Revise candidate or own-stream subtitles; optionally queue rendering and upload")
    p.add_argument("--id", required=True, type=int)
    p.add_argument("--from", dest="from_text", required=True)
    p.add_argument("--to", dest="to_text", required=True)
    p.add_argument("--cue", type=int, default=None)
    p.add_argument("--note", default="")
    p.add_argument("--enqueue", action="store_true")
    p.set_defaults(func=edit_candidate)

    p = sub.add_parser("rebuild", help="Prepare a rendered own-stream/topic revision or recover an overlong candidate; never renders immediately")
    p.add_argument("--id", required=True, type=int)
    p.add_argument("--review-note", required=True)
    p.add_argument("--title", default=None)
    p.add_argument("--description", default=None)
    p.add_argument("--cover-text", default=None)
    p.add_argument("--source-kind", choices=("live_speech", "recount", "playback", "audience"), default=None)
    p.add_argument("--start", type=float, default=None)
    p.add_argument("--end", type=float, default=None)
    p.add_argument("--allow-long", action="store_true")
    p.add_argument("--duration-note", default=None)
    p.add_argument("--xml", default=None, help="Explicit original danmaku XML to bind when legacy topic metadata omitted it")
    p.add_argument("--enqueue", action="store_true")
    p.set_defaults(func=lambda args: clip_candidate_queue.prepare_rebuild(args, sys.modules[__name__]))

    p = sub.add_parser("preview", help="Prepare reusable unburned rough video and matching SRT for held candidates; never approve or upload")
    p.add_argument("--ids", required=True)
    p.add_argument("--timeout-seconds", type=int, default=1800)
    p.set_defaults(func=lambda args: clip_candidate_queue.preview_candidates(args, sys.modules[__name__]))

    p = sub.add_parser("cut", help="Render held topic candidates by their reserved short IDs; never auto-upload")
    p.add_argument("--ids", required=True)
    p.add_argument("--review-note", required=True)
    p.add_argument("--title", default=None)
    p.add_argument("--description", default=None)
    p.add_argument("--cover-text", default=None)
    p.set_defaults(func=cut_candidates)

    p = sub.add_parser("approve-review", help="Save explicit human review for a rendered own-stream clip; never uploads")
    p.add_argument("--id", required=True, type=int)
    p.add_argument("--review-note", required=True)
    p.add_argument("--title", default=None)
    p.add_argument("--description", default=None)
    p.add_argument("--cover-text", default=None)
    p.add_argument("--source-kind", choices=("live_speech", "recount", "playback", "audience"), default=None)
    p.set_defaults(func=approve_rendered_review)

    p = sub.add_parser("enqueue", help="Queue upload by ID; the background worker renders approved candidates first")
    p.add_argument("--ids", required=True)
    p.add_argument("--delay", type=int, default=DEFAULT_DELAY)
    p.add_argument("--rate-limit-wait", type=int, default=DEFAULT_RATE_LIMIT_WAIT)
    p.add_argument("--rate-limit-retries", type=int, default=DEFAULT_RATE_LIMIT_RETRIES)
    p.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    p.add_argument(
        "--timeout-seconds",
        type=int,
        default=DEFAULT_BATCH_TIMEOUT_SECONDS,
        help="每个小批次的子进程超时秒数",
    )
    p.add_argument("--note", default="")
    p.add_argument("--force", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=enqueue)

    p = sub.add_parser("cancel", help="Cancel a pending upload job")
    p.add_argument("--job", required=True)
    p.add_argument("--note", default="")
    p.set_defaults(func=cancel_job)

    p = sub.add_parser(
        "resume",
        help="Clear a manually confirmed-stale Bilibili submission cooldown",
    )
    p.add_argument("--note", default="")
    p.set_defaults(func=resume_uploads)

    p = sub.add_parser("queue", help="Show upload queue")
    p.add_argument("--verbose", action="store_true")
    p.set_defaults(func=queue_status)

    p = sub.add_parser("worker", help="Run one queued upload job or loop forever")
    p.add_argument("--loop", action="store_true")
    p.add_argument("--interval", type=int, default=30)
    p.add_argument("--idle-interval", type=int, default=30)
    p.set_defaults(func=worker)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    ensure_runtime_dir()
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
