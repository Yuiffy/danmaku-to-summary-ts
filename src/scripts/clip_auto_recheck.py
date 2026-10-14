"""Explicit current-artifact review or bounded repair under an existing ordinary ID."""

import argparse
import json
import sys


def register_commands(sub, api):
    parser = sub.add_parser("recheck-auto", help="Repair current ordinary copy defects and independently recheck the same pending IDs")
    parser.add_argument("--ids", required=True)
    parser.add_argument("--enqueue", action="store_true", help="Enqueue only independently passed revisions through automatic policy")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--repair-subtitles", action="store_true", help="Check at most four short audio windows with two unprompted local models before revising subtitles")
    mode.add_argument("--review-final", action="store_true", help="Review the current final without edits or rendering; concrete topic keyword doubts may use bounded audio diagnosis")
    parser.set_defaults(func=lambda args: recheck_auto(args, api))
    retry = sub.add_parser("retry-auto", help="Reconcile a terminal prior automatic attempt and enqueue only the freshly passed repaired artifact")
    retry.add_argument("--id", required=True, type=int)
    retry.add_argument("--prior-metadata", required=True, help="Preserved metadata snapshot matching the old queue authorization")
    retry.add_argument("--dry-run", action="store_true")
    retry.set_defaults(func=lambda args: retry_auto(args, api))


def retry_auto(args, api):
    command = ["enqueue", "--automatic", "--ids", str(args.id)]
    if args.dry_run:
        command.append("--dry-run")
    enqueue = api.build_parser().parse_args(command)
    enqueue.prior_metadata = args.prior_metadata
    return api.enqueue(enqueue)


def recheck_auto(args, api):
    ids = api.parse_int_list(args.ids)
    if not ids:
        print("[ERROR] explicit IDs are required", file=sys.stderr)
        return 2
    failures = 0
    for clip_id in ids:
        try:
            registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
            clip = registry.get("clips", {}).get(str(clip_id))
            if not clip or not clip.get("metadataPath") or clip.get("status") not in ("needs_review", "review"):
                raise ValueError("Only inactive existing pending IDs can be rechecked")
            command = ["node", str(api.PROJECT_ROOT / "src/scripts/recheck_own_publication.js"),
                       "--id", str(clip_id), "--metadata", clip["metadataPath"],
                       "--registry-path", str(api.REGISTRY_PATH), "--queue-path", str(api.QUEUE_PATH)]
            if getattr(args, "repair_subtitles", False):
                command.append("--repair-subtitles")
            if getattr(args, "review_final", False):
                command.append("--review-final")
            completed = api.subprocess.run(command, cwd=api.PROJECT_ROOT, capture_output=True,
                                           encoding="utf-8", errors="replace", timeout=1800,
                                           **api.hidden_subprocess_kwargs())
            if completed.returncode:
                raise ValueError((completed.stderr or completed.stdout or "Automatic recheck failed").strip())
            lines = [line for line in completed.stdout.splitlines() if line.startswith("PUBLICATION_RECHECK_RESULT: ")]
            if len(lines) != 1:
                raise ValueError("Automatic recheck did not return an unambiguous saved receipt")
            receipt = json.loads(lines[0].split(": ", 1)[1])
            if receipt.get("id") != clip_id:
                raise ValueError("Automatic recheck returned a different numeric ID")
            if receipt.get("changed"):
                imported = api.import_json(argparse.Namespace(manifest=clip["metadataPath"], review=clip.get("reviewPath"),
                    state=clip.get("statePath"), source="", prefix="", tags="", tid=None, label="", batch_id="", include_pending=True))
                if imported:
                    raise ValueError("Rechecked metadata could not be refreshed in the registry")
            print("PUBLICATION_RECHECK_RESULT: " + json.dumps(receipt, ensure_ascii=False), flush=True)
            if args.enqueue and receipt.get("decision") == "auto_queue":
                enqueue = api.build_parser().parse_args(["enqueue", "--automatic", "--ids", str(clip_id)])
                if api.enqueue(enqueue):
                    raise ValueError("Automatic enqueue needs attention; inspect its persisted receipt before retrying")
        except (OSError, ValueError, api.subprocess.TimeoutExpired) as error:
            failures += 1
            print(f"[ERROR] ID{clip_id}: {error}", file=sys.stderr, flush=True)
    return 2 if failures else 0
