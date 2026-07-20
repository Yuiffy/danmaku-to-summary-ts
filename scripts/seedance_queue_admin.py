#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from seedance_queue_store import QueueStore


def tasks(data: dict[str, Any]) -> list[dict[str, Any]]:
    queue_tasks = data.get("tasks")
    if not isinstance(queue_tasks, list):
        raise ValueError("queue JSON must contain a list at key 'tasks'")
    return queue_tasks


def replace_ref(args: argparse.Namespace) -> int:
    if args.dry_run:
        data = QueueStore(args.queue).load()
        fixed = sum(1 for task in tasks(data) for image in task.get("reference_images", []) if image == args.old)
    else:
        store = QueueStore(args.queue)
        with store.transaction() as data:
            fixed = 0
            for task in tasks(data):
                images = task.get("reference_images")
                if not isinstance(images, list):
                    continue
                for index, image in enumerate(images):
                    if image == args.old:
                        images[index] = args.new
                        fixed += 1
            store.save(data)
    action = "would replace" if args.dry_run else "replaced"
    print(f"{action} {fixed} reference image paths")
    return 0


def clear_runtime_state(task: dict[str, Any], repeat: int, note: str) -> None:
    task["status"] = "pending"
    task["completed"] = 0
    task["remaining"] = repeat
    task["submit_ids"] = []
    task["inflight"] = []
    for key in ("submit_id", "submitted_at", "submission_reservations", "paused_at", "paused_reason", "fail_count", "querying_without_queue_info_checks"):
        task.pop(key, None)
    if note:
        task["note"] = note


def reset_tasks(args: argparse.Namespace) -> int:
    wanted_ids = set(args.task_ids)
    if args.dry_run:
        data = QueueStore(args.queue).load()
        present = {str(task.get("id", "")) for task in tasks(data)}
        reset_count = sum(1 for task in tasks(data) if str(task.get("id", "")) in wanted_ids)
    else:
        store = QueueStore(args.queue)
        with store.transaction() as data:
            present = {str(task.get("id", "")) for task in tasks(data)}
            reset_count = 0
            for task in tasks(data):
                if str(task.get("id", "")) not in wanted_ids:
                    continue
                clear_runtime_state(task, int(task.get("repeat") or args.default_repeat), args.note)
                reset_count += 1
            store.save(data)
    missing = sorted(wanted_ids - present)
    action = "would reset" if args.dry_run else "reset"
    print(f"{action} {reset_count} tasks")
    if missing:
        print("missing task ids: " + ", ".join(missing))
        return 1
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Admin helpers for a seedance_queue.json file.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    replace = subparsers.add_parser("replace-ref", help="replace a reference image path in all tasks")
    replace.add_argument("queue", type=Path, help="path to seedance_queue.json")
    replace.add_argument("--old", required=True, help="old reference image path")
    replace.add_argument("--new", required=True, help="new reference image path")
    replace.add_argument("--dry-run", action="store_true", help="report changes without writing the queue")
    replace.set_defaults(func=replace_ref)

    reset = subparsers.add_parser("reset-tasks", help="reset selected tasks to pending")
    reset.add_argument("queue", type=Path, help="path to seedance_queue.json")
    reset.add_argument("task_ids", nargs="+", help="task ids, for example task_056")
    reset.add_argument("--default-repeat", type=int, default=3, help="repeat count when a task has no repeat value")
    reset.add_argument("--note", default="", help="optional note to write to each reset task")
    reset.add_argument("--dry-run", action="store_true", help="report changes without writing the queue")
    reset.set_defaults(func=reset_tasks)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
