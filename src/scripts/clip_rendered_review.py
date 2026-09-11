"""Explicit human review for an existing rendered clip; never uploads."""

import argparse
import sys
from pathlib import Path


def approve_review(args, api):
    handle = api.acquire_queue_mutation_lock()
    clip = None
    try:
        registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
        clip = registry.get("clips", {}).get(str(args.id))
        if not clip or not clip.get("metadataPath") or clip.get("pendingCut"):
            raise ValueError("A registered rendered clip ID is required")
        queue = api.load_json(api.QUEUE_PATH, api.default_queue())
        if args.id in api.clip_candidate_queue.active_ids(queue) or clip.get("status") == "uploaded":
            raise ValueError("Queued/uploaded clips cannot be changed by this review command")
        if not clip.get("reviewPending"):
            print(f"[OK] {args.id} is already review-ready; no change made")
            return 0
        command = ["node", str(api.PROJECT_ROOT / "src/scripts/review_rendered_clip.js"),
                   "--metadata", clip["metadataPath"], "--id", str(args.id),
                   "--review-index", str(clip["reviewIndex"]), "--review-note", args.review_note]
        for name in ("title", "description", "cover_text", "source_kind"):
            value = getattr(args, name, None)
            if value is not None:
                command.extend(["--" + name.replace("_", "-"), value])
        result = api.subprocess.run(command, cwd=api.PROJECT_ROOT, capture_output=True, encoding="utf-8",
                                    errors="replace", timeout=180, **api.hidden_subprocess_kwargs())
        if result.returncode:
            raise ValueError((result.stderr or result.stdout or "Human review failed").strip())
    except (OSError, ValueError, api.subprocess.TimeoutExpired) as error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 2
    finally:
        api.release_queue_mutation_lock(handle)
    imported = api.import_json(argparse.Namespace(manifest=clip["metadataPath"], review=clip["reviewPath"],
        state=clip["statePath"], source="", prefix="", tags="", tid=None, label="", batch_id=""))
    if imported:
        return imported
    if clip.get("reviewPlanPath") and Path(clip["reviewPlanPath"]).is_file():
        refreshed = api.subprocess.run(["node", str(api.PROJECT_ROOT / "src/scripts/own_stream_review.js"),
            "--plan", clip["reviewPlanPath"]], cwd=api.PROJECT_ROOT, capture_output=True, encoding="utf-8",
            errors="replace", timeout=180, **api.hidden_subprocess_kwargs())
        if refreshed.returncode:
            print(f"[WARN] Review saved, but list refresh failed: {refreshed.stderr}", file=sys.stderr)
    print(f"[OK] ID{args.id}: human review saved; upload is NOT queued")
    return 0
