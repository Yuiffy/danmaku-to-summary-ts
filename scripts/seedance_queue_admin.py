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


def replace_ref_in_tasks(args: argparse.Namespace) -> int:
    wanted_ids = set(args.task_ids)
    if args.dry_run:
        data = QueueStore(args.queue).load()
        selected = [task for task in tasks(data) if str(task.get("id", "")) in wanted_ids]
        fixed = sum(
            1
            for task in selected
            for image in task.get("reference_images", [])
            if image == args.old
        )
    else:
        store = QueueStore(args.queue)
        with store.transaction() as data:
            selected = [task for task in tasks(data) if str(task.get("id", "")) in wanted_ids]
            fixed = 0
            for task in selected:
                images = task.get("reference_images")
                if not isinstance(images, list):
                    continue
                for index, image in enumerate(images):
                    if image == args.old:
                        images[index] = args.new
                        fixed += 1
            store.save(data)
    present_ids = {str(task.get("id", "")) for task in selected}
    missing = sorted(wanted_ids - present_ids)
    action = "would replace" if args.dry_run else "replaced"
    print(f"{action} {fixed} reference image paths in {len(selected)} tasks")
    if missing:
        print("missing task ids: " + ", ".join(missing))
        return 1
    return 0


def replace_text_in_tasks(args: argparse.Namespace) -> int:
    wanted_ids = set(args.task_ids)
    if args.dry_run:
        data = QueueStore(args.queue).load()
        selected = [task for task in tasks(data) if str(task.get("id", "")) in wanted_ids]
        fixed = sum(
            str(task.get("prompt") or "").count(args.old)
            for task in selected
        )
    else:
        store = QueueStore(args.queue)
        with store.transaction() as data:
            selected = [task for task in tasks(data) if str(task.get("id", "")) in wanted_ids]
            fixed = 0
            for task in selected:
                prompt = task.get("prompt")
                if not isinstance(prompt, str):
                    continue
                fixed += prompt.count(args.old)
                task["prompt"] = prompt.replace(args.old, args.new)
            store.save(data)
    present_ids = {str(task.get("id", "")) for task in selected}
    missing = sorted(wanted_ids - present_ids)
    action = "would replace" if args.dry_run else "replaced"
    print(f"{action} {fixed} prompt text occurrences in {len(selected)} tasks")
    if missing:
        print("missing task ids: " + ", ".join(missing))
        return 1
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


def task_has_started(task: dict[str, Any]) -> bool:
    """Return whether a task has generated work or has an external submission in flight."""
    try:
        if int(task.get("completed") or 0) > 0:
            return True
    except (TypeError, ValueError):
        pass
    if task.get("submit_ids"):
        return True
    return bool(task.get("inflight") or task.get("submission_reservations"))


def retire_or_delete(args: argparse.Namespace) -> int:
    wanted_ids = set(args.task_ids)
    if args.dry_run:
        data = QueueStore(args.queue).load()
        selected = [task for task in tasks(data) if str(task.get("id", "")) in wanted_ids]
        retired = sum(1 for task in selected if task_has_started(task))
        deleted = len(selected) - retired
    else:
        store = QueueStore(args.queue)
        with store.transaction() as data:
            queue_tasks = tasks(data)
            selected = [task for task in queue_tasks if str(task.get("id", "")) in wanted_ids]
            retained = []
            retired = 0
            deleted = 0
            for task in queue_tasks:
                if str(task.get("id", "")) not in wanted_ids:
                    retained.append(task)
                    continue
                if task_has_started(task):
                    completed = max(0, int(task.get("completed") or 0))
                    task["repeat"] = completed
                    task["remaining"] = 0
                    task["status"] = "submitted" if (task.get("inflight") or task.get("submission_reservations")) else "completed"
                    task["note"] = f"retired: {args.reason}; completed={completed}; remaining=0"
                    retained.append(task)
                    retired += 1
                else:
                    deleted += 1
            data["tasks"] = retained
            store.save(data)
    present_ids = {str(task.get("id", "")) for task in selected}
    missing = sorted(wanted_ids - present_ids)
    action = "would retire" if args.dry_run else "retired"
    delete_action = "would delete" if args.dry_run else "deleted"
    print(f"{action} {retired} started tasks (remaining=0)")
    print(f"{delete_action} {deleted} not-started tasks")
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

    replace_selected = subparsers.add_parser(
        "replace-ref-in-tasks",
        help="replace a reference image path only in selected tasks",
    )
    replace_selected.add_argument("queue", type=Path, help="path to seedance_queue.json")
    replace_selected.add_argument("task_ids", nargs="+", help="task ids to update")
    replace_selected.add_argument("--old", required=True, help="old reference image path")
    replace_selected.add_argument("--new", required=True, help="new reference image path")
    replace_selected.add_argument("--dry-run", action="store_true", help="report changes without writing the queue")
    replace_selected.set_defaults(func=replace_ref_in_tasks)

    replace_text = subparsers.add_parser(
        "replace-text-in-tasks",
        help="replace prompt text only in selected tasks",
    )
    replace_text.add_argument("queue", type=Path, help="path to seedance_queue.json")
    replace_text.add_argument("task_ids", nargs="+", help="task ids to update")
    replace_text.add_argument("--old", required=True, help="old prompt text")
    replace_text.add_argument("--new", required=True, help="new prompt text")
    replace_text.add_argument("--dry-run", action="store_true", help="report changes without writing the queue")
    replace_text.set_defaults(func=replace_text_in_tasks)

    reset = subparsers.add_parser("reset-tasks", help="reset selected tasks to pending")
    reset.add_argument("queue", type=Path, help="path to seedance_queue.json")
    reset.add_argument("task_ids", nargs="+", help="task ids, for example task_056")
    reset.add_argument("--default-repeat", type=int, default=3, help="repeat count when a task has no repeat value")
    reset.add_argument("--note", default="", help="optional note to write to each reset task")
    reset.add_argument("--dry-run", action="store_true", help="report changes without writing the queue")
    reset.set_defaults(func=reset_tasks)

    retire = subparsers.add_parser(
        "retire-or-delete",
        help="retire started tasks with remaining=0 and delete tasks that never started",
    )
    retire.add_argument("queue", type=Path, help="path to seedance_queue.json")
    retire.add_argument("task_ids", nargs="+", help="task ids to retire or delete")
    retire.add_argument("--reason", default="replaced by revised task design", help="retirement note")
    retire.add_argument("--dry-run", action="store_true", help="report changes without writing the queue")
    retire.set_defaults(func=retire_or_delete)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
