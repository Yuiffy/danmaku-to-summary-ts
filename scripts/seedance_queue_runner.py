#!/usr/bin/env python3
"""Two-lane Seedance queue runner: one normal job plus bounded VIP work."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from seedance_queue_store import DEFAULT_QUEUE_PATH, QueueStore

DREAMINA = "dreamina"
DEFAULT_MODEL = "seedance2.0"
DEFAULT_RESOLUTION = "720p"
VALID_MODELS = {"seedance2.0", "seedance2.0mini", "seedance2.0_vip", "seedance2.0fast_vip"}
VALID_RESOLUTIONS = {"720p", "1080p", "4k"}
SESSION = "14778786782988"
DURATION = "15"
DEFAULT_RATIO = "16:9"
POLL = "30"
DEFAULT_INTERVAL = 30
ERROR_INTERVAL = 300
MIN_QUERY_INTERVAL = 60
MAX_QUERY_INTERVAL = 1800
MAX_FAIL_RETRIES = 3
SCRIPT_VERSION = "2026-07-21-vip-two-lane-1"


@dataclass
class RunnerOptions:
    max_vip_inflight: int = 24
    max_normal_inflight: int = 1
    max_submissions_per_pass: int = 24
    submit_delay: float = 2.0
    submit_interval: int = 15
    dry_run: bool = False


@dataclass
class RunResult:
    next_interval: int = DEFAULT_INTERVAL
    submitted: int = 0


class SubmitRejected(RuntimeError):
    def __init__(self, submit_id: Optional[str], reason: str):
        super().__init__(reason)
        self.submit_id = submit_id
        self.reason = reason


def now() -> int:
    return int(time.time())


def remaining(task: Dict[str, Any]) -> int:
    return max(0, int(task.get("repeat") or 0) - int(task.get("completed") or 0))


def resolved_model(task: Dict[str, Any]) -> str:
    return str(task.get("model_version") or DEFAULT_MODEL)


def resolved_resolution(task: Dict[str, Any]) -> str:
    return str(task.get("video_resolution") or DEFAULT_RESOLUTION)


def task_lane(task: Dict[str, Any]) -> str:
    return "vip" if resolved_model(task).endswith("_vip") else "normal"


def inflight(task: Dict[str, Any]) -> List[Dict[str, Any]]:
    attempts = task.get("inflight")
    return attempts if isinstance(attempts, list) else []


def reservations(task: Dict[str, Any]) -> List[Dict[str, Any]]:
    values = task.get("submission_reservations")
    return values if isinstance(values, list) else []


def active_attempt_count(task: Dict[str, Any]) -> int:
    return len(inflight(task)) + len(reservations(task))


def validate_profile(task: Dict[str, Any]) -> Optional[str]:
    model = resolved_model(task)
    resolution = resolved_resolution(task)
    if model not in VALID_MODELS:
        return f"unsupported model_version: {model}"
    if resolution not in VALID_RESOLUTIONS:
        return f"unsupported video_resolution: {resolution}"
    if not model.endswith("_vip") and resolution != "720p":
        return f"{model} supports only 720p"
    images = task.get("reference_images")
    if not isinstance(images, list) or not images:
        return "reference_images must contain at least one image"
    missing = [str(path) for path in images if not Path(str(path)).is_file()]
    return f"reference image missing: {missing[0]}" if missing else None


def task_by_id(data: Dict[str, Any], task_id: str) -> Optional[Dict[str, Any]]:
    for task in data.get("tasks", []):
        if str(task.get("id")) == task_id:
            return task
    return None


def update_status(task: Dict[str, Any]) -> None:
    task["remaining"] = remaining(task)
    if task.get("status") == "paused":
        return
    task["status"] = "submitted" if active_attempt_count(task) else ("completed" if remaining(task) <= 0 else "pending")


def normalize_task(task: Dict[str, Any]) -> bool:
    """Normalize legacy submission fields in memory; caller decides whether to persist."""
    changed = False
    if not isinstance(task.get("inflight"), list):
        task["inflight"] = []
        changed = True
    if not isinstance(task.get("submission_reservations"), list):
        task["submission_reservations"] = []
        changed = True
    if task.get("status") == "submitted" and not task["inflight"] and not task["submission_reservations"]:
        ids = task.get("submit_ids")
        sid = str(ids[-1]) if isinstance(ids, list) and ids else (str(task["submit_id"]) if task.get("submit_id") else None)
        if sid:
            task["inflight"].append({"submit_id": sid, "submitted_at": int(task.get("submitted_at") or now()), "last_query_at": None, "next_query_at": now()})
            changed = True
        else:
            task["status"] = "pending" if remaining(task) else "completed"
            task["note"] = f"{task.get('id')} recovered from submitted-without-submit_id"
            changed = True
    update_status(task)
    return changed


def normalize_data(data: Dict[str, Any]) -> bool:
    changed = False
    for task in data.get("tasks", []):
        if isinstance(task, dict):
            changed = normalize_task(task) or changed
    return changed


def queue_wait_seconds(queue_info: Dict[str, Any]) -> Optional[int]:
    for key in ("wait_seconds", "estimated_wait_seconds", "estimate_wait_seconds", "expected_wait_seconds", "eta_seconds", "remain_seconds", "remaining_seconds"):
        try:
            if queue_info.get(key) is not None:
                return max(0, int(float(str(queue_info[key]).strip())))
        except (TypeError, ValueError):
            pass
    for key in ("wait_minutes", "estimated_wait_minutes", "estimate_wait_minutes", "expected_wait_minutes", "eta_minutes", "remain_minutes", "remaining_minutes"):
        try:
            if queue_info.get(key) is not None:
                return max(0, int(float(str(queue_info[key]).strip())) * 60)
        except (TypeError, ValueError):
            pass
    return None


def next_query_interval(queue_info: Dict[str, Any]) -> int:
    wait = queue_wait_seconds(queue_info)
    if wait is not None:
        return MAX_QUERY_INTERVAL if wait > 3600 else 300 if wait > 900 else 120 if wait > 180 else MIN_QUERY_INTERVAL
    for key in ("queue_idx", "queue_index", "position"):
        try:
            position = int(float(str(queue_info[key]).strip()))
            return MAX_QUERY_INTERVAL if position > 20 else 300 if position > 5 else 120 if position > 1 else MIN_QUERY_INTERVAL
        except (KeyError, TypeError, ValueError):
            continue
    return 300


def tail_json(text: str) -> Dict[str, Any]:
    decoder = json.JSONDecoder()
    found: List[Tuple[int, Dict[str, Any]]] = []
    for match in re.finditer(r"\{", text):
        try:
            data, end = decoder.raw_decode(text[match.start():])
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            found.append((match.start() + end, data))
    if not found:
        raise RuntimeError(text.strip() or "no json found")
    return max(found, key=lambda item: item[0])[1]


def run(cmd: List[str], timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def submit(task: Dict[str, Any]) -> str:
    cmd = [DREAMINA, "multimodal2video", "--model_version", resolved_model(task), "--duration", DURATION, "--ratio", str(task.get("ratio") or DEFAULT_RATIO), "--video_resolution", resolved_resolution(task), "--session", SESSION, "--poll", POLL]
    for image in task.get("reference_images", []):
        cmd += ["--image", str(image)]
    cmd += ["--prompt", str(task["prompt"])]
    print(f"submit start version={SCRIPT_VERSION} task={task.get('id')} lane={task_lane(task)} model={resolved_model(task)} active={active_attempt_count(task)} remaining={remaining(task)}")
    cp = run(cmd, 1800)
    output = (cp.stdout or "") + "\n" + (cp.stderr or "")
    if cp.returncode != 0:
        raise RuntimeError(output.strip())
    data = tail_json(output)
    sid = data.get("submit_id")
    if data.get("gen_status") == "fail":
        raise SubmitRejected(str(sid) if sid else None, str(data.get("fail_reason") or "submit rejected"))
    if not sid:
        raise RuntimeError(f"submit_id missing: {output.strip()}")
    return str(sid)


def query(sid: str) -> Dict[str, Any]:
    cp = run([DREAMINA, "query_result", f"--submit_id={sid}"], 300)
    output = (cp.stdout or "") + "\n" + (cp.stderr or "")
    if cp.returncode != 0:
        raise RuntimeError(output.strip())
    return tail_json(output)


def download(sid: str, queue_path: Path) -> None:
    cp = run([DREAMINA, "query_result", f"--submit_id={sid}", f"--download_dir={queue_path.parent}"], 1800)
    if cp.returncode != 0:
        raise RuntimeError(((cp.stdout or "") + "\n" + (cp.stderr or "")).strip())


def is_moderation_rejection(reason: str) -> bool:
    text = reason.lower()
    return "pre-tns check did not pass" in text or "tns check did not pass" in text


def is_concurrency_rejection(reason: str) -> bool:
    return "exceedconcurrencylimit" in reason.lower() or "concurrency limit" in reason.lower()


def is_deterministic_rejection(reason: str) -> bool:
    text = reason.lower()
    return any(marker in text for marker in ("invalid param", "invalid parameter", "video_resolution", "model_version", "image not found", "file not found"))


def is_transient_query_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(marker in text for marker in ("timeout", "timed out", "context deadline exceeded", "awaiting headers", "connection reset", "temporarily unavailable"))


def pause_task(task: Dict[str, Any], reason: str) -> None:
    task["status"] = "paused"
    task["paused_at"] = now()
    task["paused_reason"] = reason
    task["remaining"] = remaining(task)
    task["note"] = f"{task.get('id')} paused ({reason}); completed={task.get('completed')} remaining={task['remaining']}"


def record_attempt_failure(task: Dict[str, Any], reason: str) -> None:
    count = int(task.get("fail_count") or 0) + 1
    task["fail_count"] = count
    if count >= MAX_FAIL_RETRIES:
        pause_task(task, f"{MAX_FAIL_RETRIES} consecutive failures: {reason}")
    else:
        update_status(task)
        task["note"] = f"{task.get('id')} failed attempt #{count}/{MAX_FAIL_RETRIES} ({reason}); will retry"


def lane_active_count(tasks: Iterable[Dict[str, Any]], lane: str) -> int:
    return sum(active_attempt_count(task) for task in tasks if task_lane(task) == lane)


def lane_cooldown_until(data: Dict[str, Any], lane: str) -> int:
    runner = data.get("_seedance_runner", {})
    cooldowns = runner.get("submission_cooldown_until", {}) if isinstance(runner, dict) else {}
    return int(cooldowns.get(lane) or 0) if isinstance(cooldowns, dict) else 0


def set_lane_cooldown(data: Dict[str, Any], lane: str, seconds: int, reason: str) -> None:
    runner = data.setdefault("_seedance_runner", {})
    cooldowns = runner.setdefault("submission_cooldown_until", {})
    cooldowns[lane] = now() + seconds
    runner["last_cooldown_reason"] = reason


def eligible_tasks(tasks: List[Dict[str, Any]], lane: str) -> List[Dict[str, Any]]:
    result = []
    for task in tasks:
        if task_lane(task) != lane or task.get("status") == "paused":
            continue
        if remaining(task) <= active_attempt_count(task):
            continue
        result.append(task)
    return result


def select_submission_tasks(data: Dict[str, Any], options: RunnerOptions) -> List[Dict[str, Any]]:
    tasks = data.get("tasks", [])
    selected: List[Dict[str, Any]] = []
    planned_by_id: Dict[str, int] = {}
    limits = {"vip": max(0, options.max_vip_inflight), "normal": max(0, options.max_normal_inflight)}
    for lane in ("vip", "normal"):
        if lane_cooldown_until(data, lane) > now():
            continue
        available = max(0, limits[lane] - lane_active_count(tasks, lane))
        candidates = eligible_tasks(tasks, lane)
        while available and candidates and len(selected) < options.max_submissions_per_pass:
            progressed = False
            for task in candidates:
                if available <= 0 or len(selected) >= options.max_submissions_per_pass:
                    break
                task_id = str(task.get("id"))
                # One attempt per task per round, then round-robin only while repeats remain.
                planned = planned_by_id.get(task_id, 0)
                if remaining(task) > active_attempt_count(task) + planned:
                    selected.append(task)
                    planned_by_id[task_id] = planned + 1
                    available -= 1
                    progressed = True
            if not progressed:
                break
    return selected


def reserve_submission(store: QueueStore, task_id: str) -> Tuple[Optional[Dict[str, Any]], Optional[str], Optional[str]]:
    """Return a fresh task snapshot, reservation token, or a validation error."""
    with store.transaction() as data:
        normalize_data(data)
        task = task_by_id(data, task_id)
        if not task or task.get("status") == "paused" or remaining(task) <= active_attempt_count(task):
            return None, None, "task no longer eligible"
        error = validate_profile(task)
        if error:
            pause_task(task, error)
            store.save(data)
            return None, None, error
        token = uuid.uuid4().hex
        task.setdefault("submission_reservations", []).append({"token": token, "created_at": now(), "state": "submitting"})
        update_status(task)
        task["note"] = f"{task.get('id')} submission reserved ({token[:8]})"
        store.save(data)
        return dict(task), token, None


def pop_reservation(task: Dict[str, Any], token: str) -> Optional[Dict[str, Any]]:
    values = reservations(task)
    for index, reservation in enumerate(values):
        if reservation.get("token") == token:
            return values.pop(index)
    return None


def apply_submission_success(store: QueueStore, task_id: str, token: str, sid: str) -> None:
    with store.transaction() as data:
        task = task_by_id(data, task_id)
        if not task or not pop_reservation(task, token):
            raise RuntimeError(f"reservation disappeared for {task_id}; remote submit_id={sid} requires review")
        ids = task.setdefault("submit_ids", [])
        if isinstance(ids, list):
            ids.append(sid)
        task.setdefault("inflight", []).append({"submit_id": sid, "submitted_at": now(), "last_query_at": None, "next_query_at": now() + MIN_QUERY_INTERVAL})
        update_status(task)
        task["note"] = f"submitted {sid} ({task_lane(task)} lane)"
        store.save(data)


def apply_submission_rejection(store: QueueStore, task_id: str, token: str, reason: str, sid: Optional[str] = None) -> None:
    with store.transaction() as data:
        task = task_by_id(data, task_id)
        if not task or not pop_reservation(task, token):
            return
        if sid:
            task.setdefault("submit_ids", []).append(sid)
        if is_concurrency_rejection(reason):
            set_lane_cooldown(data, task_lane(task), 120, reason)
            update_status(task)
            task["note"] = f"provider concurrency cooldown ({task_lane(task)} lane): {reason}"
        elif is_moderation_rejection(reason) or is_deterministic_rejection(reason):
            pause_task(task, f"submit rejected: {reason}")
        else:
            record_attempt_failure(task, f"submit rejected: {reason}")
        store.save(data)


def mark_ambiguous_submission(store: QueueStore, task_id: str, token: str, reason: str) -> None:
    with store.transaction() as data:
        task = task_by_id(data, task_id)
        if not task:
            return
        for reservation in reservations(task):
            if reservation.get("token") == token:
                reservation["state"] = "needs_review"
                reservation["reason"] = reason
                reservation["updated_at"] = now()
                task["note"] = f"ambiguous submission requires review: {reason}"
                store.save(data)
                return


def due_attempts(data: Dict[str, Any]) -> List[Tuple[str, str]]:
    current = now()
    due: List[Tuple[str, str]] = []
    for task in data.get("tasks", []):
        for attempt in inflight(task):
            sid = attempt.get("submit_id")
            if sid and int(attempt.get("next_query_at") or 0) <= current:
                due.append((str(task.get("id")), str(sid)))
    return due


def find_attempt(task: Dict[str, Any], sid: str) -> Optional[Dict[str, Any]]:
    return next((attempt for attempt in inflight(task) if str(attempt.get("submit_id")) == sid), None)


def apply_query_result(store: QueueStore, task_id: str, sid: str, result: Dict[str, Any]) -> int:
    status = result.get("gen_status")
    if status == "success":
        download(sid, store.path)
    with store.transaction() as data:
        task = task_by_id(data, task_id)
        if not task:
            return DEFAULT_INTERVAL
        attempt = find_attempt(task, sid)
        if not attempt:
            return DEFAULT_INTERVAL
        if status == "querying":
            queue_info = result.get("queue_info") if isinstance(result.get("queue_info"), dict) else {}
            interval = next_query_interval(queue_info)
            attempt["last_query_at"] = now()
            attempt["next_query_at"] = now() + interval
            task["note"] = f"{sid} querying ({task_lane(task)} lane), next check={interval}s"
            store.save(data)
            return interval
        if status == "success":
            inflight(task).remove(attempt)
            task["completed"] = int(task.get("completed") or 0) + 1
            task["fail_count"] = 0
            update_status(task)
            task["note"] = f"{sid} completed; completed={task['completed']} remaining={task['remaining']}"
            store.save(data)
            return MIN_QUERY_INTERVAL
        if status == "fail":
            inflight(task).remove(attempt)
            reason = str(result.get("fail_reason") or "failed attempt")
            if is_moderation_rejection(reason) or is_deterministic_rejection(reason):
                pause_task(task, f"generation rejected: {reason}")
            else:
                record_attempt_failure(task, reason)
            store.save(data)
            return MIN_QUERY_INTERVAL
        attempt["last_query_at"] = now()
        attempt["next_query_at"] = now() + 300
        task["note"] = f"{sid} unknown status {status!r}; retained for retry"
        store.save(data)
        return 300


def sync_due_attempts(store: QueueStore, dry_run: bool) -> int:
    if dry_run:
        return DEFAULT_INTERVAL
    snapshot = store.load()
    intervals = []
    for task_id, sid in due_attempts(snapshot):
        try:
            result = query(sid)
            intervals.append(apply_query_result(store, task_id, sid, result))
        except Exception as exc:
            print(f"query retained {task_id} ({sid}): {exc}")
            with store.transaction() as data:
                task = task_by_id(data, task_id)
                attempt = find_attempt(task, sid) if task else None
                if attempt:
                    attempt["last_query_at"] = now()
                    attempt["next_query_at"] = now() + MIN_QUERY_INTERVAL
                    task["note"] = f"query error retained {sid}: {exc}"
                    store.save(data)
            intervals.append(MIN_QUERY_INTERVAL)
    return min(intervals) if intervals else DEFAULT_INTERVAL


def run_once(store: QueueStore, options: RunnerOptions) -> RunResult:
    data = store.load()
    if options.dry_run:
        selected = select_submission_tasks(data, options)
        print(f"dry-run queue tasks={len(data.get('tasks', []))} vip_active={lane_active_count(data.get('tasks', []), 'vip')}/{options.max_vip_inflight} normal_active={lane_active_count(data.get('tasks', []), 'normal')}/{options.max_normal_inflight}")
        for task in selected:
            print(f"would submit {task.get('id')} lane={task_lane(task)} model={resolved_model(task)} resolution={resolved_resolution(task)} remaining={remaining(task)}")
        return RunResult(options.submit_interval)

    # Persist legacy normalization before scheduling.
    with store.transaction() as locked:
        if normalize_data(locked):
            store.save(locked)
    sync_due_attempts(store, dry_run=False)
    data = store.load()
    selected = select_submission_tasks(data, options)
    submitted = 0
    blocked_lanes: set[str] = set()
    for selected_task in selected:
        lane = task_lane(selected_task)
        if lane in blocked_lanes:
            continue
        snapshot, token, error = reserve_submission(store, str(selected_task.get("id")))
        if error:
            print(f"skip {selected_task.get('id')}: {error}")
            continue
        assert snapshot and token
        try:
            sid = submit(snapshot)
        except SubmitRejected as exc:
            apply_submission_rejection(store, str(snapshot.get("id")), token, exc.reason, exc.submit_id)
            print(f"submit rejected {snapshot.get('id')}: {exc.reason}")
            if is_concurrency_rejection(exc.reason):
                blocked_lanes.add(lane)
        except Exception as exc:
            mark_ambiguous_submission(store, str(snapshot.get("id")), token, str(exc))
            print(f"ambiguous submission {snapshot.get('id')}: {exc}")
        else:
            apply_submission_success(store, str(snapshot.get("id")), token, sid)
            submitted += 1
            print(f"submitted {sid} lane={task_lane(snapshot)}")
        if options.submit_delay > 0 and submitted < len(selected):
            time.sleep(options.submit_delay)
    return RunResult(options.submit_interval, submitted)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue", type=Path, default=DEFAULT_QUEUE_PATH, help="queue JSON path (test/maintenance override)")
    parser.add_argument("--dry-run", action="store_true", help="local scheduling preview; does not query or write")
    parser.add_argument("--fill", action="store_true", help="one capacity-fill pass (default behavior when not using --loop)")
    parser.add_argument("--loop", action="store_true", help="maintain both lanes continuously")
    parser.add_argument("--max-vip-inflight", type=int, default=24)
    parser.add_argument("--max-normal-inflight", type=int, default=1)
    parser.add_argument("--max-submissions-per-pass", type=int, default=24)
    parser.add_argument("--submit-delay", type=float, default=2)
    parser.add_argument("--submit-interval", type=int, default=15)
    parser.add_argument("--error-interval", type=int, default=ERROR_INTERVAL)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    options = RunnerOptions(args.max_vip_inflight, args.max_normal_inflight, args.max_submissions_per_pass, args.submit_delay, args.submit_interval, args.dry_run)
    store = QueueStore(args.queue)
    if not args.loop:
        run_once(store, options)
        return 0
    while True:
        try:
            result = run_once(store, options)
            print(f"sleep {result.next_interval}s submitted={result.submitted}", flush=True)
            time.sleep(max(1, result.next_interval))
        except KeyboardInterrupt:
            raise
        except Exception as exc:
            print(str(exc), file=sys.stderr, flush=True)
            time.sleep(max(1, args.error_interval))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
