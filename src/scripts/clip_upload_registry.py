#!/usr/bin/env python
"""Short-id registry and queue for reviewed Bilibili clip uploads."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

PROJECT_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_DIR = PROJECT_ROOT / "data" / "runtime"
REGISTRY_PATH = RUNTIME_DIR / "clip_upload_registry.json"
QUEUE_PATH = RUNTIME_DIR / "clip_upload_queue.json"
LOCK_PATH = RUNTIME_DIR / "clip_upload_worker.lock"
DEFAULT_DELAY = 60
DEFAULT_RATE_LIMIT_WAIT = 120
DEFAULT_RATE_LIMIT_RETRIES = 5


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def ensure_runtime_dir() -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)


def load_json(path: Path, default: Dict[str, Any]) -> Dict[str, Any]:
    if not path.exists():
        return json.loads(json.dumps(default))
    with path.open("r", encoding="utf-8-sig") as f:
        return json.load(f)


def save_json(path: Path, data: Dict[str, Any]) -> None:
    ensure_runtime_dir()
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


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


def parse_review(review_path: Path) -> List[Dict[str, Any]]:
    clips: List[Dict[str, Any]] = []
    cover_by_idx: Dict[int, str] = {}
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
                        "title": m.group(2).strip(),
                        "start": m.group(3).strip(),
                        "duration": m.group(4).strip(),
                        "mediaPath": (m.group(5) or "").strip(),
                    }
                )
                continue
            cm = re.match(r"^\s*封面:\s*(.+?)\s*$", line)
            if cm and previous_idx is not None:
                cover_by_idx[previous_idx] = cm.group(1).strip()

    for clip in clips:
        cover = cover_by_idx.get(clip["reviewIndex"])
        if cover:
            clip["coverPath"] = cover
    return clips


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


def import_review(args: argparse.Namespace) -> int:
    review_path = Path(args.review).expanduser().resolve()
    if not review_path.exists():
        print(f"[ERROR] REVIEW.md not found: {review_path}", file=sys.stderr)
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


def clip_status_from_state(clip: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    state_path = Path(clip.get("statePath") or "")
    if not state_path.exists():
        return None
    state = load_json(state_path, {})
    idx = str(clip.get("reviewIndex"))
    done = state.get("done", {})
    if idx in done:
        return {"status": "uploaded", **done[idx]}
    got_406 = state.get("got_406", {})
    if idx in got_406:
        return {"status": "needs_retry", **got_406[idx]}
    return None


def sync_clip_statuses(registry: Dict[str, Any], ids: Iterable[int]) -> None:
    for clip_id in ids:
        clip = registry.get("clips", {}).get(str(clip_id))
        if not clip:
            continue
        status = clip_status_from_state(clip)
        if not status:
            continue
        clip["status"] = status.pop("status")
        clip["uploadState"] = status
        clip["updatedAt"] = now_iso()


def list_clips(args: argparse.Namespace) -> int:
    registry = load_json(REGISTRY_PATH, default_registry())
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
    registry = load_json(REGISTRY_PATH, default_registry())
    missing = [clip_id for clip_id in ids if str(clip_id) not in registry.get("clips", {})]
    if missing:
        print(f"[ERROR] unknown clip ids: {missing}", file=sys.stderr)
        return 2
    sync_clip_statuses(registry, ids)
    already_uploaded = [clip_id for clip_id in ids if registry["clips"][str(clip_id)].get("status") == "uploaded"]
    if already_uploaded and not args.force:
        print(f"[ERROR] already uploaded ids (use --force to enqueue anyway): {already_uploaded}", file=sys.stderr)
        return 2
    if args.dry_run:
        for clip_id in ids:
            clip = registry["clips"][str(clip_id)]
            print(f"{clip_id}: #{clip.get('reviewIndex')} {clip.get('prefix', '')}{clip.get('title', '')}")
        return 0

    queue = load_json(QUEUE_PATH, default_queue())
    job = {
        "id": f"upload-{int(time.time())}",
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
        "status": "pending",
        "clipIds": ids,
        "delay": int(args.delay),
        "rateLimitWait": int(args.rate_limit_wait),
        "rateLimitRetries": int(args.rate_limit_retries),
        "note": args.note or "",
    }
    queue.setdefault("jobs", []).append(job)
    for clip_id in ids:
        clip = registry["clips"][str(clip_id)]
        if clip.get("status") != "uploaded":
            clip["status"] = "queued"
            clip["updatedAt"] = now_iso()
    save_json(QUEUE_PATH, queue)
    save_json(REGISTRY_PATH, registry)
    print(f"[OK] queued {len(ids)} clips as {job['id']}: {','.join(str(i) for i in ids)}")
    return 0


def queue_status(args: argparse.Namespace) -> int:
    queue = load_json(QUEUE_PATH, default_queue())
    for job in queue.get("jobs", []):
        print(
            f"{job.get('id')} {job.get('status')} ids={','.join(str(i) for i in job.get('clipIds', []))} "
            f"updated={job.get('updatedAt')}"
        )
        if args.verbose and job.get("lastOutput"):
            print(str(job["lastOutput"])[-2000:])
    return 0


def grouped_clips(registry: Dict[str, Any], ids: List[int]) -> List[List[Dict[str, Any]]]:
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for clip_id in ids:
        clip = registry["clips"][str(clip_id)]
        key = batch_key(
            clip["reviewPath"],
            clip["source"],
            clip["prefix"],
            clip["tags"],
            int(clip["tid"]),
            clip["statePath"],
        )
        groups.setdefault(key, []).append(clip)
    return list(groups.values())


def run_batch(group: List[Dict[str, Any]], job: Dict[str, Any]) -> subprocess.CompletedProcess[str]:
    first = group[0]
    only = ",".join(str(int(clip["reviewIndex"])) for clip in group)
    cmd = [
        sys.executable,
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
    print("[worker] run:", " ".join(f'"{c}"' if " " in c else c for c in cmd), flush=True)
    return subprocess.run(
        cmd,
        cwd=str(PROJECT_ROOT),
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def next_pending_job(queue: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    for job in queue.get("jobs", []):
        if job.get("status") == "pending":
            return job
    return None


def mark_job(job: Dict[str, Any], status: str, **extra: Any) -> None:
    job["status"] = status
    job["updatedAt"] = now_iso()
    job.update(extra)


def acquire_lock(stale_seconds: int = 12 * 60 * 60) -> bool:
    ensure_runtime_dir()
    lock_payload = json.dumps({"pid": os.getpid(), "time": time.time()})
    while True:
        try:
            fd = os.open(str(LOCK_PATH), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(lock_payload)
            return True
        except FileExistsError:
            pass

        try:
            existing = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
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
    try:
        if LOCK_PATH.exists():
            LOCK_PATH.unlink()
    except OSError:
        pass


def run_one_job() -> bool:
    registry = load_json(REGISTRY_PATH, default_registry())
    queue = load_json(QUEUE_PATH, default_queue())
    job = next_pending_job(queue)
    if not job:
        return False

    ids = [int(i) for i in job.get("clipIds", [])]
    missing = [clip_id for clip_id in ids if str(clip_id) not in registry.get("clips", {})]
    if missing:
        mark_job(job, "failed", error=f"missing registry ids: {missing}")
        save_json(QUEUE_PATH, queue)
        return True

    sync_clip_statuses(registry, ids)
    pending_ids = [clip_id for clip_id in ids if registry["clips"][str(clip_id)].get("status") != "uploaded"]
    if not pending_ids:
        mark_job(job, "done", result="all ids already uploaded")
        save_json(REGISTRY_PATH, registry)
        save_json(QUEUE_PATH, queue)
        return True

    mark_job(job, "running", startedAt=now_iso())
    for clip_id in pending_ids:
        registry["clips"][str(clip_id)]["status"] = "uploading"
        registry["clips"][str(clip_id)]["updatedAt"] = now_iso()
    save_json(REGISTRY_PATH, registry)
    save_json(QUEUE_PATH, queue)

    all_outputs: List[str] = []
    failed = False
    for group in grouped_clips(registry, pending_ids):
        cp = run_batch(group, job)
        output = cp.stdout or ""
        all_outputs.append(output[-8000:])
        print(output, end="", flush=True)
        if cp.returncode != 0:
            failed = True
            break
        registry = load_json(REGISTRY_PATH, default_registry())
        sync_clip_statuses(registry, [int(clip["id"]) for clip in group])
        save_json(REGISTRY_PATH, registry)

    registry = load_json(REGISTRY_PATH, default_registry())
    sync_clip_statuses(registry, ids)
    save_json(REGISTRY_PATH, registry)
    queue = load_json(QUEUE_PATH, default_queue())
    current = next((item for item in queue.get("jobs", []) if item.get("id") == job.get("id")), job)
    statuses = {clip_id: registry["clips"][str(clip_id)].get("status") for clip_id in ids}
    if failed:
        mark_job(current, "failed", clipStatuses=statuses, lastOutput="\n".join(all_outputs)[-12000:])
    elif all(status == "uploaded" for status in statuses.values()):
        mark_job(current, "done", clipStatuses=statuses, lastOutput="\n".join(all_outputs)[-12000:])
    else:
        mark_job(current, "blocked", clipStatuses=statuses, lastOutput="\n".join(all_outputs)[-12000:])
    save_json(QUEUE_PATH, queue)
    return True


def worker(args: argparse.Namespace) -> int:
    if not acquire_lock():
        return 3
    try:
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

    p = sub.add_parser("list", help="List registered clips")
    p.add_argument("--status", default="")
    p.add_argument("--paths", action="store_true")
    p.set_defaults(func=list_clips)

    p = sub.add_parser("show", help="Show clip records as JSON")
    p.add_argument("ids")
    p.set_defaults(func=show_clips)

    p = sub.add_parser("enqueue", help="Queue registered clips for upload by short ids")
    p.add_argument("--ids", required=True)
    p.add_argument("--delay", type=int, default=DEFAULT_DELAY)
    p.add_argument("--rate-limit-wait", type=int, default=DEFAULT_RATE_LIMIT_WAIT)
    p.add_argument("--rate-limit-retries", type=int, default=DEFAULT_RATE_LIMIT_RETRIES)
    p.add_argument("--note", default="")
    p.add_argument("--force", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=enqueue)

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
