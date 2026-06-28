#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

QUEUE_PATH = Path(r"D:\files\Pictures\AI图保存\seedance\近期岁己居家下载\seedance_queue.json")
DREAMINA = "dreamina"
MODEL = "seedance2.0"
SESSION = "14778786782988"
DURATION = "15"
RATIO = "9:16"
POLL = "30"
DEFAULT_INTERVAL = 300
ERROR_INTERVAL = 300
MIN_INTERVAL = 60
MAX_INTERVAL = 1800
QUERY_TIMEOUT_INTERVAL = 60
SCRIPT_VERSION = "2026-06-25-seedance-debug-1"
STALE_QUERYING_SECONDS = 6 * 60 * 60
MAX_QUERYING_WITHOUT_QUEUE_INFO_CHECKS = 5


@dataclass
class RunResult:
    next_interval: int = DEFAULT_INTERVAL


class SubmitRejected(RuntimeError):
    def __init__(self, submit_id: Optional[str], reason: str):
        super().__init__(reason)
        self.submit_id = submit_id
        self.reason = reason


def load_queue() -> Dict[str, Any]:
    return json.loads(QUEUE_PATH.read_text(encoding="utf-8"))


def save_queue(data: Dict[str, Any]) -> None:
    QUEUE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def remaining(task: Dict[str, Any]) -> int:
    return max(0, int(task.get("repeat") or 0) - int(task.get("completed") or 0))


def next_pending_task(tasks: List[Dict[str, Any]], skip_task_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    for t in tasks:
        if t.get("status") != "pending":
            continue
        if skip_task_id and t.get("id") == skip_task_id:
            continue
        return t
    return None


def last_submit_id(task: Dict[str, Any]) -> Optional[str]:
    ids = task.get("submit_ids") or []
    if isinstance(ids, list) and ids:
        return str(ids[-1])
    sid = task.get("submit_id")
    return str(sid) if sid else None


def run(cmd: List[str], timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def tail_json(text: str) -> Dict[str, Any]:
    decoder = json.JSONDecoder()
    found: List[Tuple[int, Dict[str, Any]]] = []
    for m in re.finditer(r"\{", text):
        try:
            data, end = decoder.raw_decode(text[m.start():])
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            found.append((m.start() + end, data))
    if not found:
        raise RuntimeError(text.strip() or "no json found")
    return max(found, key=lambda item: item[0])[1]


def int_or_none(value: Any) -> Optional[int]:
    try:
        if value is None:
            return None
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return None


def queue_wait_seconds(queue_info: Dict[str, Any]) -> Optional[int]:
    keys = (
        "wait_seconds",
        "estimated_wait_seconds",
        "estimate_wait_seconds",
        "expected_wait_seconds",
        "eta_seconds",
        "remain_seconds",
        "remaining_seconds",
    )
    for key in keys:
        seconds = int_or_none(queue_info.get(key))
        if seconds is not None:
            return max(0, seconds)

    minute_keys = (
        "wait_minutes",
        "estimated_wait_minutes",
        "estimate_wait_minutes",
        "expected_wait_minutes",
        "eta_minutes",
        "remain_minutes",
        "remaining_minutes",
    )
    for key in minute_keys:
        minutes = int_or_none(queue_info.get(key))
        if minutes is not None:
            return max(0, minutes * 60)

    return None


def next_query_interval(queue_info: Dict[str, Any]) -> int:
    wait_seconds = queue_wait_seconds(queue_info)
    if wait_seconds is not None:
        if wait_seconds > 3600:
            return MAX_INTERVAL
        if wait_seconds > 900:
            return 300
        if wait_seconds > 180:
            return 120
        return MIN_INTERVAL

    queue_idx = int_or_none(queue_info.get("queue_idx"))
    if queue_idx is None:
        queue_idx = int_or_none(queue_info.get("queue_index"))
    if queue_idx is None:
        queue_idx = int_or_none(queue_info.get("position"))

    if queue_idx is None:
        return DEFAULT_INTERVAL
    if queue_idx > 20:
        return MAX_INTERVAL
    if queue_idx > 5:
        return 300
    if queue_idx > 1:
        return 120
    return MIN_INTERVAL


def queue_info_has_position(queue_info: Dict[str, Any]) -> bool:
    keys = (
        "queue_idx",
        "queue_index",
        "position",
        "queue_length",
        "wait_seconds",
        "estimated_wait_seconds",
        "estimate_wait_seconds",
        "expected_wait_seconds",
        "eta_seconds",
        "remain_seconds",
        "remaining_seconds",
        "wait_minutes",
        "estimated_wait_minutes",
        "estimate_wait_minutes",
        "expected_wait_minutes",
        "eta_minutes",
        "remain_minutes",
        "remaining_minutes",
    )
    return any(queue_info.get(key) is not None for key in keys)


def remember_submission(task: Dict[str, Any], sid: str) -> None:
    ids = task.setdefault("submit_ids", [])
    if not isinstance(ids, list):
        ids = []
        task["submit_ids"] = ids
    ids.append(sid)
    task["status"] = "submitted"
    task["submitted_at"] = int(time.time())
    task.pop("querying_without_queue_info_checks", None)
    task["note"] = f"submitted {sid}"


def clear_submission_tracking(task: Dict[str, Any]) -> None:
    task.pop("submitted_at", None)
    task.pop("querying_without_queue_info_checks", None)


def finish_attempt(data: Dict[str, Any], task: Dict[str, Any], outcome: str) -> None:
    task["completed"] = int(task.get("completed") or 0) + 1
    task["remaining"] = remaining(task)
    task["status"] = "completed" if task["remaining"] <= 0 else "pending"
    task["note"] = f"{task.get('id')} {outcome}; completed={task['completed']} remaining={task['remaining']}"
    clear_submission_tracking(task)
    save_queue(data)


def submit(task: Dict[str, Any]) -> str:
    cmd = [DREAMINA, "multimodal2video", "--model_version", MODEL, "--duration", DURATION, "--ratio", RATIO, "--session", SESSION, "--poll", POLL]
    for img in task.get("reference_images", []):
        cmd += ["--image", img]
    cmd += ["--prompt", task["prompt"]]
    print(f"submit start version={SCRIPT_VERSION} task={task.get('id')} images={len(task.get('reference_images', []))} repeat={task.get('repeat')} completed={task.get('completed')} remaining={remaining(task)}")
    print("submit cmd:", " ".join(cmd))
    cp = run(cmd, 1800)
    out = (cp.stdout or "") + "\n" + (cp.stderr or "")
    print(f"submit rc={cp.returncode}")
    if out.strip():
        print("submit raw:\n" + out.strip())
    if cp.returncode != 0:
        raise RuntimeError(out.strip())
    data = tail_json(out)
    print("submit parsed:", json.dumps(data, ensure_ascii=False))
    sid = data.get("submit_id")
    if data.get("gen_status") == "fail":
        reason = str(data.get("fail_reason") or "submit rejected")
        raise SubmitRejected(str(sid) if sid else None, reason)
    if not sid:
        raise RuntimeError(f"submit_id missing:\n{out}")
    return str(sid)


def query(sid: str) -> Dict[str, Any]:
    print(f"query start version={SCRIPT_VERSION} submit_id={sid}")
    cp = run([DREAMINA, "query_result", f"--submit_id={sid}"], 300)
    out = (cp.stdout or "") + "\n" + (cp.stderr or "")
    print(f"query rc={cp.returncode}")
    if out.strip():
        print("query raw:\n" + out.strip())
    if cp.returncode != 0:
        raise RuntimeError(out.strip())
    data = tail_json(out)
    print("query parsed:", json.dumps(data, ensure_ascii=False))
    return data


def download(sid: str) -> None:
    cp = run([DREAMINA, "query_result", f"--submit_id={sid}", f"--download_dir={QUEUE_PATH.parent}"], 1800)
    out = (cp.stdout or "") + "\n" + (cp.stderr or "")
    if cp.returncode != 0:
        raise RuntimeError(out.strip())


def notify(kind: str, task: Dict[str, Any], sid: str, info: str) -> None:
    pass


def is_transient_query_error(exc: Exception) -> bool:
    text = str(exc).lower()
    markers = [
        "timeout",
        "timed out",
        "context deadline exceeded",
        "client.timeout exceeded",
        "awaiting headers",
        "connection reset",
        "temporarily unavailable",
    ]
    return any(marker in text for marker in markers)


def submit_next_pending(data: Dict[str, Any], skip_task_id: Optional[str] = None, dry_run: bool = False) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    tasks = data.get("tasks", [])
    next_task = next_pending_task(tasks, skip_task_id=skip_task_id)
    if not next_task:
        return None, None
    if dry_run:
        print(f"would submit {next_task.get('id')} remaining={remaining(next_task)}")
        return None, next_task
    try:
        sid = submit(next_task)
    except SubmitRejected as e:
        if e.submit_id:
            ids = next_task.setdefault("submit_ids", [])
            if isinstance(ids, list):
                ids.append(e.submit_id)
        finish_attempt(data, next_task, f"submit rejected ({e.reason})")
        print(f"submit rejected {next_task.get('id')}: {e.reason}")
        return None, next_task
    remember_submission(next_task, sid)
    save_queue(data)
    print(f"submitted {sid}")
    return sid, next_task


def query_submitted_task(data: Dict[str, Any], task: Dict[str, Any], dry_run: bool = False) -> RunResult:
    print(f"submitted task id={task.get('id')} status={task.get('status')} repeat={task.get('repeat')} completed={task.get('completed')} remaining={remaining(task)}")
    sid = last_submit_id(task)
    if not sid:
        raise RuntimeError(f"submitted task {task.get('id')} has no submit_id")

    try:
        result = query(sid)
        gs = result.get("gen_status")
        print(f"current submitted task result gen_status={gs}")
        if gs == "querying":
            q = result.get("queue_info", {})
            if not isinstance(q, dict):
                q = {}
            if not queue_info_has_position(q):
                checks = int(task.get("querying_without_queue_info_checks") or 0) + 1
                task["querying_without_queue_info_checks"] = checks
                submitted_at = int_or_none(task.get("submitted_at"))
                age = int(time.time()) - submitted_at if submitted_at is not None else None
                if (
                    submitted_at is None
                    or age >= STALE_QUERYING_SECONDS
                    or checks >= MAX_QUERYING_WITHOUT_QUEUE_INFO_CHECKS
                ):
                    if submitted_at is None:
                        reason = "legacy submitted task"
                    elif checks >= MAX_QUERYING_WITHOUT_QUEUE_INFO_CHECKS:
                        reason = f"no queue_info after {checks} checks"
                    else:
                        reason = f"submitted {age}s ago"
                    finish_attempt(data, task, f"stale querying without queue_info ({reason})")
                    print(f"stale querying without queue_info {sid}; released task for retry")
                    return RunResult(MIN_INTERVAL)
                save_queue(data)
            interval = next_query_interval(q)
            print(f"queueing {q.get('queue_idx', '?')}/{q.get('queue_length', '?')} next_check={interval}s")
            return RunResult(interval)

        if gs == "success":
            download(sid)
            finish_attempt(data, task, "completed")
            notify("success", task, sid, "done")
            print(f"done {sid}")
            return RunResult(MIN_INTERVAL if task["remaining"] > 0 else DEFAULT_INTERVAL)

        if gs == "fail":
            finish_attempt(data, task, "failed attempt")
            notify("fail", task, sid, "failed")
            print(f"fail {sid}")
            return RunResult(MIN_INTERVAL if task["remaining"] > 0 else DEFAULT_INTERVAL)

        raise RuntimeError(f"unknown gen_status: {gs}")
    except Exception as e:
        if is_transient_query_error(e):
            print(f"query timeout on {task.get('id')} ({sid}); will retry next cycle (sequential mode)")
            print(f"query timeout detail: {e}")
            task["note"] = f"query timeout on {sid}; will retry"
            save_queue(data)
            return RunResult(QUERY_TIMEOUT_INTERVAL)
        print(f"query unexpected error on {task.get('id')} ({sid}): {e}")
        raise


def run_once(dry_run: bool = False) -> RunResult:
    data = load_queue()
    tasks = data.get("tasks", [])
    print(f"queue loaded version={SCRIPT_VERSION} tasks={len(tasks)}")

    # Strict sequential mode: if any task is currently submitted (in-flight),
    # only query it. Never submit a new task while another is still pending.
    submitted_tasks = [t for t in tasks if t.get("status") == "submitted"]

    if submitted_tasks:
        intervals = [query_submitted_task(data, task, dry_run).next_interval for task in submitted_tasks]
        interval = min(intervals) if intervals else DEFAULT_INTERVAL
        if any(t.get("status") == "submitted" for t in tasks):
            return RunResult(interval)

    # No task currently submitted — submit the next pending one.
    pending_task = next_pending_task(tasks)
    if not pending_task:
        print("NO_REPLY")
        return RunResult(DEFAULT_INTERVAL)

    print(f"pending task id={pending_task.get('id')} status={pending_task.get('status')} repeat={pending_task.get('repeat')} completed={pending_task.get('completed')} remaining={remaining(pending_task)}")
    if dry_run:
        print(f"would submit {pending_task.get('id')} remaining={remaining(pending_task)}")
        return RunResult(DEFAULT_INTERVAL)
    try:
        sid = submit(pending_task)
    except SubmitRejected as e:
        if e.submit_id:
            ids = pending_task.setdefault("submit_ids", [])
            if isinstance(ids, list):
                ids.append(e.submit_id)
        finish_attempt(data, pending_task, f"submit rejected ({e.reason})")
        print(f"submit rejected {pending_task.get('id')}: {e.reason}")
        return RunResult(MIN_INTERVAL)
    remember_submission(pending_task, sid)
    save_queue(data)
    print(f"submitted {sid}")
    return RunResult(MIN_INTERVAL)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--loop", action="store_true", help="run continuously instead of one pass")
    ap.add_argument("--interval", type=int, default=DEFAULT_INTERVAL, help="default seconds between successful passes in loop mode")
    ap.add_argument("--error-interval", type=int, default=ERROR_INTERVAL, help="seconds to wait after an error in loop mode")
    ap.add_argument("--adaptive", action="store_true", help="adjust submitted-task query interval from queue info")
    args = ap.parse_args()

    if not args.loop:
        run_once(args.dry_run)
        return 0

    while True:
        try:
            result = run_once(args.dry_run)
            interval = result.next_interval if args.adaptive else args.interval
            print(f"sleep {interval}s", flush=True)
            time.sleep(max(1, interval))
        except KeyboardInterrupt:
            raise
        except Exception as e:
            print(str(e), file=sys.stderr, flush=True)
            time.sleep(max(1, args.error_interval))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print(str(e), file=sys.stderr)
        raise SystemExit(1)
