#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

QUEUE_PATH = Path(r"D:\files\Pictures\AI图保存\seedance\近期岁己居家下载\seedance_queue.json")
DREAMINA = "dreamina"
MODEL = "seedance2.0"
SESSION = "14778786782988"
DURATION = "15"
RATIO = "3:4"
POLL = "30"


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
    m = re.findall(r"\{.*?\}", text, re.S)
    if not m:
        raise RuntimeError(text.strip() or "no json found")
    return json.loads(m[-1])


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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    data = load_queue()
    task = active_task(data.get("tasks", []))
    if not task:
        print("NO_REPLY")
        return 0

    if task.get("status") == "pending":
        if args.dry_run:
            print(f"would submit {task.get('id')} remaining={remaining(task)}")
            return 0
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
        return 0

    sid = last_submit_id(task)
    if not sid:
        raise RuntimeError(f"submitted task {task.get('id')} has no submit_id")

    result = query(sid)
    gs = result.get("gen_status")
    if gs == "querying":
        q = result.get("queue_info", {})
        print(f"queueing {q.get('queue_idx', '?')}/{q.get('queue_length', '?')}")
        return 0

    if gs == "success":
        download(sid)
        task["completed"] = int(task.get("completed") or 0) + 1
        task["remaining"] = remaining(task)
        task["status"] = "completed" if task["remaining"] <= 0 else "pending"
        task["note"] = f"{task.get('id')} completed={task['completed']} remaining={task['remaining']}"
        save_queue(data)
        notify("success", task, sid, "done")
        print(f"done {sid}")
        return 0

    if gs == "fail":
        task["completed"] = int(task.get("completed") or 0) + 1
        task["remaining"] = remaining(task)
        task["status"] = "completed" if task["remaining"] <= 0 else "pending"
        task["note"] = f"{task.get('id')} failed attempt; completed={task['completed']} remaining={task['remaining']}"
        save_queue(data)
        notify("fail", task, sid, "failed")
        print(f"fail {sid}")
        return 0

    raise RuntimeError(f"unknown gen_status: {gs}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print(str(e), file=sys.stderr)
        raise SystemExit(1)
