"""Explicit human enqueue path; dependencies remain injectable through the registry API."""

import argparse
import subprocess
import sys
import time


def enqueue(args: argparse.Namespace, api) -> int:
    ids = api.parse_int_list(args.ids)
    if not ids:
        print("[ERROR] --ids is empty", file=sys.stderr)
        return 2
    batch_size = int(getattr(args, "batch_size", api.DEFAULT_BATCH_SIZE))
    timeout_seconds = int(
        getattr(args, "timeout_seconds", api.DEFAULT_BATCH_TIMEOUT_SECONDS)
    )
    if batch_size < 1:
        print("[ERROR] --batch-size must be at least 1", file=sys.stderr)
        return 2
    if timeout_seconds < 60:
        print("[ERROR] --timeout-seconds must be at least 60", file=sys.stderr)
        return 2
    registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
    missing = [clip_id for clip_id in ids if str(clip_id) not in registry.get("clips", {})]
    if missing:
        print(f"[ERROR] unknown clip ids: {missing}", file=sys.stderr)
        return 2
    held = [clip_id for clip_id in ids if registry["clips"][str(clip_id)].get("editorialExclusion") or (
            registry["clips"][str(clip_id)].get("reviewPending")
            and not registry["clips"][str(clip_id)].get("pendingRebuild"))]
    if held:
        print(f"[ERROR] IDs excluded or need review before upload (force cannot bypass): {held}. Use show/subtitles to inspect their reviewIssues.", file=sys.stderr)
        return 2
    api.sync_clip_statuses(registry, ids)
    already_uploaded = [clip_id for clip_id in ids if registry["clips"][str(clip_id)].get("status") == "uploaded"]
    revised_published = [clip_id for clip_id in ids if registry["clips"][str(clip_id)].get("subtitleRevisionKind") == "own_stream"
                         and api.clip_candidate_queue.is_published(registry["clips"][str(clip_id)])]
    if revised_published:
        print(f"[ERROR] revised published IDs require replacing their original submissions, not duplicate uploads: {revised_published}", file=sys.stderr)
        return 2
    if already_uploaded and not args.force:
        print(f"[ERROR] already uploaded ids (use --force to enqueue anyway): {already_uploaded}", file=sys.stderr)
        return 2
    collection_section_id = getattr(args, "collection_section_id", None)
    if collection_section_id is not None and (collection_section_id <= 0 or len(ids) != 1
            or not registry["clips"][str(ids[0])].get("manifestPath")):
        print("[ERROR] --collection-section-id requires one JSON-backed clip and a positive ID", file=sys.stderr)
        return 2
    if args.dry_run:
        for clip_id in ids:
            clip = registry["clips"][str(clip_id)]
            action = "cut_then_upload" if clip.get("pendingCut") or clip.get("pendingRebuild") else "upload"
            print(f"{clip_id}: [{action}] #{clip.get('reviewIndex')} {clip.get('prefix', '')}{clip.get('title', '')}")
        return 0

    with api.queue_transaction() as queue:
        # Re-read the registry under the same short lock used by every queue
        # writer. This also serializes two enqueue commands updating statuses.
        registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
        missing = [
            clip_id
            for clip_id in ids
            if str(clip_id) not in registry.get("clips", {})
        ]
        if missing:
            print(f"[ERROR] unknown clip ids: {missing}", file=sys.stderr)
            return 2
        held = [clip_id for clip_id in ids if registry["clips"][str(clip_id)].get("editorialExclusion") or (
                registry["clips"][str(clip_id)].get("reviewPending")
                and not registry["clips"][str(clip_id)].get("pendingRebuild"))]
        if held:
            print(f"[ERROR] IDs excluded or need review before upload (force cannot bypass): {held}", file=sys.stderr)
            return 2
        api.sync_clip_statuses(registry, ids)
        revised_published = [clip_id for clip_id in ids if registry["clips"][str(clip_id)].get("subtitleRevisionKind") == "own_stream"
                             and api.clip_candidate_queue.is_published(registry["clips"][str(clip_id)])]
        if revised_published:
            print(f"[ERROR] revised published IDs cannot be re-enqueued: {revised_published}", file=sys.stderr)
            return 2
        already_uploaded = [
            clip_id
            for clip_id in ids
            if registry["clips"][str(clip_id)].get("status") == "uploaded"
        ]
        if already_uploaded and not args.force:
            print(
                "[ERROR] already uploaded ids (use --force to enqueue anyway): "
                f"{already_uploaded}",
                file=sys.stderr,
            )
            return 2

        active = api.clip_candidate_queue.active_ids(queue)
        ids = [clip_id for clip_id in ids if clip_id not in active]
        if not ids:
            print("[OK] requested IDs are already queued; no duplicate job created")
            return 0
        try:
            snapshots = api.clip_candidate_queue.approve_for_queue(api, registry, ids, args.note,
                getattr(args, "expected_candidate_drafts", None))
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            print(f"[ERROR] {error}", file=sys.stderr)
            return 2

        base_job_id = f"upload-{int(time.time())}"
        existing_job_ids = {
            str(existing.get("id") or "") for existing in queue.get("jobs", [])
        }
        job_id = base_job_id
        suffix = 2
        while job_id in existing_job_ids:
            job_id = f"{base_job_id}-{suffix}"
            suffix += 1
        job = {
            "id": job_id,
            "createdAt": api.now_iso(),
            "updatedAt": api.now_iso(),
            "status": "pending",
            "clipIds": ids,
            "candidateSubtitles": snapshots,
            "delay": int(args.delay),
            "rateLimitWait": int(args.rate_limit_wait),
            "rateLimitRetries": int(args.rate_limit_retries),
            "batchSize": batch_size,
            "timeoutSeconds": timeout_seconds,
            "note": args.note or "",
            "collectionSectionId": collection_section_id,
            # ``--force`` explicitly authorizes re-submission, including when
            # Bilibili already has the same title.
            "allowDuplicateTitle": bool(args.force),
        }
        queue.setdefault("jobs", []).append(job)
        for clip_id in ids:
            clip = registry["clips"][str(clip_id)]
            if clip.get("status") != "uploaded" or args.force:
                clip["status"] = "queued"
                clip.pop("automaticPublicationAuthorization", None)
                clip.pop("failureReason", None)
                clip["updatedAt"] = api.now_iso()
        api.save_json(api.REGISTRY_PATH, registry)
    print(f"[OK] queued {len(ids)} clips as {job['id']}: {','.join(str(i) for i in ids)}")
    print(f"QUEUE_JOB_ID: {job['id']}")
    return 0
