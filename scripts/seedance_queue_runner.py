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
from typing import Any, Dict, List, Optional

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


@dataclass
class RunResult:
    next_interval: int = DEFAULT_INTERVAL


def load_queue() -> Dict[str, Any]:
    return json.loads(QUEUE_PATH.read_text(encoding="utf-8"))


def save_queue(data: Dict[str, Any]) -> None:
    QUEUE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def remaining(task: Dict[str, Any]) -> int:
    return max(0, int(task.get("repeat") or 0) - int(task.get("completed") or 0))


def active_task(tasks: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    for t in tasks:
        if t.get("status") in {"pending", "submitted"}:
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
    found: List[Dict[str, Any]] = []
    for m in re.finditer(r"\{", text):
        try:
            data, _ = decoder.raw_decode(text[m.start():])
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            found.append(data)
    if not found:
        raise RuntimeError(text.strip() or "no json found")
    return found[-1]


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


def submit(task: Dict[str, Any]) -> str:
    cmd = [DREAMINA, "multimodal2video", "--model_version", MODEL, "--duration", DURATION, "--ratio", RATIO, "--session", SESSION, "--poll", POLL]
    for img in task.get("reference_images", []):
        cmd += ["--image", img]
    cmd += ["--prompt", task["prompt"]]
    cp = run(cmd, 1800)
    out = (cp.stdout or "") + "\n" + (cp.stderr or "")
    if cp.returncode != 0:
        raise RuntimeError(out.strip())
    data = tail_json(out)
    sid = data.get("submit_id")
    if not sid:
        raise RuntimeError(f"submit_id missing:\n{out}")
    return str(sid)


def query(sid: str) -> Dict[str, Any]:
    cp = run([DREAMINA, "query_result", f"--submit_id={sid}"], 300)
    out = (cp.stdout or "") + "\n" + (cp.stderr or "")
    if cp.returncode != 0:
        raise RuntimeError(out.strip())
    return tail_json(out)


def download(sid: str) -> None:
    cp = run([DREAMINA, "query_result", f"--submit_id={sid}", f"--download_dir={QUEUE_PATH.parent}"], 1800)
    out = (cp.stdout or "") + "\n" + (cp.stderr or "")
    if cp.returncode != 0:
        raise RuntimeError(out.strip())


def notify(kind: str, task: Dict[str, Any], sid: str, info: str) -> None:
    # Placeholder: hook 企业微信 here later.
    pass


def run_once(dry_run: bool = False) -> RunResult:
    data = load_queue()
    task = active_task(data.get("tasks", []))
    if not task:
        print("NO_REPLY")
        return RunResult(DEFAULT_INTERVAL)

    if task.get("status") == "pending":
        if dry_run:
            print(f"would submit {task.get('id')} remaining={remaining(task)}")
            return RunResult(DEFAULT_INTERVAL)
        sid = submit(task)
        ids = task.setdefault("submit_ids", [])
        if not isinstance(ids, list):
            ids = []
            task["submit_ids"] = ids
        ids.append(sid)
        task["status"] = "submitted"
        task["note"] = f"submitted {sid}"
        save_queue(data)
        print(f"submitted {sid}")
        return RunResult(DEFAULT_INTERVAL)

    sid = last_submit_id(task)
    if not sid:
        raise RuntimeError(f"submitted task {task.get('id')} has no submit_id")

    result = query(sid)
    gs = result.get("gen_status")
    if gs == "querying":
        q = result.get("queue_info", {})
        if not isinstance(q, dict):
            q = {}
        interval = next_query_interval(q)
        print(f"queueing {q.get('queue_idx', '?')}/{q.get('queue_length', '?')} next_check={interval}s")
        return RunResult(interval)

    if gs == "success":
        download(sid)
        task["completed"] = int(task.get("completed") or 0) + 1
        task["remaining"] = remaining(task)
        task["status"] = "completed" if task["remaining"] <= 0 else "pending"
        task["note"] = f"{task.get('id')} completed={task['completed']} remaining={task['remaining']}"
        save_queue(data)
        notify("success", task, sid, "done")
        print(f"done {sid}")
        return RunResult(MIN_INTERVAL if task["remaining"] > 0 else DEFAULT_INTERVAL)

    if gs == "fail":
        task["completed"] = int(task.get("completed") or 0) + 1
        task["remaining"] = remaining(task)
        task["status"] = "completed" if task["remaining"] <= 0 else "pending"
        task["note"] = f"{task.get('id')} failed attempt; completed={task['completed']} remaining={task['remaining']}"
        save_queue(data)
        notify("fail", task, sid, "failed")
        print(f"fail {sid}")
        return RunResult(MIN_INTERVAL if task["remaining"] > 0 else DEFAULT_INTERVAL)

    raise RuntimeError(f"unknown gen_status: {gs}")


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
