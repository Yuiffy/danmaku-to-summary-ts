#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def load_queue(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def save_queue(path: Path, data: dict[str, Any], dry_run: bool) -> None:
    if dry_run:
        return
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def tasks(data: dict[str, Any]) -> list[dict[str, Any]]:
    queue_tasks = data.get("tasks")
    if not isinstance(queue_tasks, list):
        raise ValueError("queue JSON must contain a list at key 'tasks'")
    return queue_tasks


def replace_ref(args: argparse.Namespace) -> int:
    data = load_queue(args.queue)
    fixed = 0

    for task in tasks(data):
        images = task.get("reference_images")
        if not isinstance(images, list):
            continue
        for idx, image in enumerate(images):
            if image == args.old:
                images[idx] = args.new
                fixed += 1

    save_queue(args.queue, data, args.dry_run)
    action = "would replace" if args.dry_run else "replaced"
    print(f"{action} {fixed} reference image paths")
    return 0


def reset_tasks(args: argparse.Namespace) -> int:
    data = load_queue(args.queue)
    wanted_ids = set(args.task_ids)
    reset_count = 0

    for task in tasks(data):
        task_id = str(task.get("id", ""))
        if task_id not in wanted_ids:
            continue

        repeat = int(task.get("repeat") or args.default_repeat)
        task["status"] = "pending"
        task["completed"] = 0
        task["remaining"] = repeat
        task["submit_ids"] = []
        task.pop("submit_id", None)
        task.pop("submitted_at", None)
        task.pop("paused_at", None)
        task.pop("paused_reason", None)
        task.pop("querying_without_queue_info_checks", None)
        if args.note:
            task["note"] = args.note
        reset_count += 1

    missing = sorted(wanted_ids - {str(task.get("id", "")) for task in tasks(data)})
    save_queue(args.queue, data, args.dry_run)

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
    reset.add_argument("task_ids", nargs="+", help="task ids to reset, for example task_056")
    reset.add_argument("--default-repeat", type=int, default=3, help="repeat count when a task has no repeat value")
    reset.add_argument("--note", default="", help="optional note to write to each reset task")
    reset.add_argument("--dry-run", action="store_true", help="report changes without writing the queue")
    reset.set_defaults(func=reset_tasks)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
