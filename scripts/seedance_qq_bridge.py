"""Bounded QQ admission/status adapter for the existing locked Seedance store.

Only the trusted QQ process invokes this JSON-stdin bridge; model tools never supply paths.
"""
from __future__ import annotations

import argparse
import json
import re
import secrets
import sys
import time
import uuid
from pathlib import Path

from seedance_queue_store import QueueStore
from seedance_qq_limits import admission, policy

MODELS = {"seedance2.0fast_vip", "seedance2.0mini"}
RATIOS = {"9:16", "16:9", "1:1", "3:4", "4:3", "21:9"}
ACTIVE = {"draft", "pending", "submitted", "needs_review", "paused"}


def scope(payload):
    owner = payload["owner"]
    if not isinstance(owner, dict) or set(owner) != {"app", "user", "conversation", "request"}:
        raise ValueError("invalid owner")
    if not re.fullmatch(r"[1-9]\d{0,24}", owner["app"]) or any(
        not re.fullmatch(r"[a-f0-9]{64}", owner[key]) for key in ("user", "conversation", "request")
    ):
        raise ValueError("invalid owner")
    return owner


def owned(task, owner):
    return all(task.get("qq", {}).get(key) == owner[key] for key in ("app", "user", "conversation"))


def public_status(task):
    review = any(item.get("state") == "needs_review" for item in task.get("submission_reservations", []))
    return {"status": "needs_review" if review else task.get("status"), "taskId": task["id"],
            "draft": task.get("qq_draft") if task.get("status") == "draft" else None,
            "failureCode": task.get("failure_code"), "file": task.get("qq_output"), "requiredCredits": task.get("required_credits")}


def handle(queue: Path, payload: dict):
    owner = scope(payload)
    store = QueueStore(queue)
    if payload["action"] in {"status", "lookup", "draft"}:
        tasks = [task for task in store.load()["tasks"] if owned(task, owner)]
        if payload["action"] == "lookup":
            tasks = [task for task in tasks if task.get("qq", {}).get("request") == owner["request"]]
        if payload["action"] == "draft":
            task = tasks[-1] if tasks else None
            return {**public_status(task), "images": task["reference_images"][:task["qq_draft"]["sourceCount"]],
                    "videos": [{"file": file, "durationMs": duration} for file, duration in
                               zip(task.get("video_references", []), task.get("video_durations_ms", []))]} if task and task.get("status") == "draft" else {"status": "missing"}
        # Queue admission appends tasks: pickup follows the latest request in this
        # scope, including legacy tasks without admission/delivery timestamps.
        # An older ready video must never mask the latest task's progress/failure.
        selected = tasks[-1] if tasks else None
        return public_status(selected) if selected else {"status": "missing"}
    if payload["action"] == "delivered":
        with store.transaction() as data:
            task = next((task for task in data["tasks"] if owned(task, owner) and task["id"] == payload.get("taskId")), None)
            if not task or task.get("status") != "completed":
                return {"status": "missing"}
            task.setdefault("qq_delivered_at", int(time.time()))
            store.save(data)
            return public_status(task)
    if payload["action"] == "approve":
        with store.transaction() as data:
            tasks = [task for task in data["tasks"] if owned(task, owner)]
            if not tasks:
                return {"status": "missing"}
            task = tasks[-1]
            if task.get("status") == "draft":
                now = int(time.time())
                limited = admission(data["tasks"], owner, policy(payload), now, task["id"])
                if limited:
                    return limited
                task["status"] = "pending"
                task["draft_confirmed_at"] = now
                task["qq_admitted_at"] = now
                store.save(data)
            return public_status(task)
    if payload["action"] == "confirm":
        with store.transaction() as data:
            tasks = [task for task in data["tasks"] if owned(task, owner)]
            if not tasks:
                return {"status": "missing"}
            task = tasks[-1]
            amount = payload.get("credits")
            if task.get("failure_code") != "confirmation_required" or task.get("status") != "paused":
                return public_status(task)
            if type(amount) is not int or type(task.get("required_credits")) is not int or amount < task["required_credits"] or not 0 <= amount <= 100000:
                raise ValueError("invalid confirmation")
            task["canvas"]["approvedCredits"] = amount
            task["status"] = "pending"
            task.pop("failure_code", None)
            task.pop("required_credits", None)
            store.save(data)
            return public_status(task)
    if payload["action"] != "enqueue":
        raise ValueError("unknown action")
    task_id = "qq_" + owner["app"] + "_" + owner["request"]
    # Replays remain successful even after credits or local input availability change.
    existing = next((task for task in store.load()["tasks"] if task.get("id") == task_id), None)
    if existing:
        if existing.get("qq") != owner:
            raise ValueError("owner mismatch")
        return public_status(existing)
    if payload.get("model") not in MODELS or payload.get("ratio") not in RATIOS or payload.get("resolution") != "720p":
        raise ValueError("unsupported profile")
    duration = payload.get("duration")
    if type(duration) is not int or not 4 <= duration <= 15:
        raise ValueError("invalid duration")
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 12000:
        raise ValueError("invalid prompt")
    refs, audio = payload.get("images"), payload.get("audio")
    videos, video_durations = payload.get("videos", []), payload.get("videoDurationsMs", [])
    if (not isinstance(refs, list) or not 0 <= len(refs) <= 9 or not isinstance(audio, list) or len(audio) > 3 or
            not isinstance(videos, list) or len(videos) > 3 or audio and not (refs or videos)):
        raise ValueError("invalid references")
    if (len(refs) + len(audio) + len(videos) > 12 or not isinstance(video_durations, list) or
            len(video_durations) != len(videos) or any(type(value) is not int or not 2000 <= value <= 15400 for value in video_durations) or
            sum(video_durations) > 15400):
        raise ValueError("invalid video references")
    draft = payload.get("draft")
    if not isinstance(draft, dict) or not isinstance(draft.get("prompt"), str) or draft["prompt"] != prompt or not isinstance(draft.get("materials"), list) or type(draft.get("sourceCount")) is not int or not 0 <= draft["sourceCount"] <= len(refs):
        raise ValueError("invalid draft")
    if type(draft.get("videoSourceCount", 0)) is not int or draft.get("videoSourceCount", 0) != len(videos):
        raise ValueError("invalid video draft")
    if type(payload.get("direct")) is not bool:
        raise ValueError("missing confirmation mode")
    for file in refs + audio + videos:
        if not isinstance(file, str) or not Path(file).is_absolute() or not Path(file).is_file():
            raise ValueError("missing reference")
    for file in videos:
        media = Path(file)
        if media.is_symlink() or not 12 <= media.stat().st_size <= 50 * 1024 * 1024:
            raise ValueError("invalid video file")
        with media.open("rb") as source:
            if source.read(12)[4:8] != b"ftyp":
                raise ValueError("invalid video format")
    with store.transaction() as data:
        existing = next((task for task in data["tasks"] if task.get("id") == task_id), None)
        if existing:
            if existing.get("qq") != owner:
                raise ValueError("owner mismatch")
            return public_status(existing)
        active = [task for task in data["tasks"] if task.get("qq") and task.get("status") in ACTIVE]
        previous = [task for task in active if owned(task, owner)]
        limits = policy(payload)
        if len(active) >= 24 and not any(task.get("status") == "draft" for task in previous):
            return {"status": "busy"}
        if payload["direct"]:
            limited = admission(data["tasks"], owner, limits, int(time.time()))
            if limited:
                return limited
        elif sum(task.get("status") != "draft" for task in previous) >= limits["maxActive"]:
            return {"status": "busy"}
        # Editing replaces only this owner's unscheduled draft; accepted/running tasks never change.
        for old in previous:
            if old.get("status") == "draft":
                old["status"] = "cancelled"
        task = {"id": task_id, "name": "QQ视频", "prompt": prompt,
                "reference_images": refs, "audio_references": audio, "video_references": videos,
                "video_durations_ms": video_durations, "ratio": payload["ratio"],
                "model_version": payload["model"], "video_resolution": "720p", "duration": duration,
                "repeat": 1, "completed": 0, "status": "pending" if payload["direct"] else "draft", "submit_ids": [], "inflight": [],
                "qq_draft": draft,
                "qq": owner, "created_at": int(time.time())}
        sender_name = payload.get("senderName")
        if isinstance(sender_name, str):
            task["qq_sender_name"] = re.sub(r"[\x00-\x1f\x7f]", " ", sender_name).strip()[:80]
        task["backend"] = "dreamina-canvas"
        task["canvas"] = {"projectId": str(uuid.uuid4()),
                          "nodeId": "node_" + "".join(secrets.choice("0123456789abcdefghjkmnpqrstvwxyz") for _ in range(10)),
                          "updateId": str(uuid.uuid4()), "submitId": str(uuid.uuid4()),
                          "imageResourceIds": [str(uuid.uuid4()) for _ in refs],
                          "audioResourceIds": [str(uuid.uuid4()) for _ in audio],
                          "videoResourceIds": [str(uuid.uuid4()) for _ in videos]}
        data["tasks"].append(task)
        if payload["direct"]:
            task["qq_admitted_at"] = int(time.time())
        store.save(data)
        return public_status(task)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--queue", required=True, type=Path)
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(128 * 1024 + 1)
        if len(raw) > 128 * 1024:
            raise ValueError("request too large")
        result = handle(args.queue, json.loads(raw.decode("utf-8")))
        print(json.dumps(result, ensure_ascii=False))
    except Exception:
        print(json.dumps({"status": "unavailable"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
