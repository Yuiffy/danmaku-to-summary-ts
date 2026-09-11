"""Candidate subtitle commands and the upload worker's render stage."""

import argparse
import json
import sys
from pathlib import Path


def candidate_action(api, clip, action, options=None, timeout=1800):
    script = "render_topic_candidate.js" if clip.get("pendingCut") else "render_own_revision.js"
    command = ["node", str(api.PROJECT_ROOT / "src/scripts" / script),
               "--metadata", clip["metadataPath"], "--candidate-id", str(clip["id"]), "--action", action]
    review = clip.get("candidateReviewPath") or clip.get("reviewPath")
    if review or not clip.get("pendingCut"):
        command.extend(["--registry-path", str(api.REGISTRY_PATH)])
    if review:
        command.extend(["--source-review", review])
    for key, value in (options or {}).items():
        if value is not None:
            command.extend(["--" + key.replace("_", "-"), str(value)])
    result = api.subprocess.run(command, cwd=api.PROJECT_ROOT, encoding="utf-8", errors="replace",
                                capture_output=True, timeout=timeout, **api.hidden_subprocess_kwargs())
    output = (result.stdout or "") + (result.stderr or "")
    if result.returncode:
        raise ValueError(output.strip() or f"candidate {action} exited with {result.returncode}")
    for line in reversed(output.splitlines()):
        if line.startswith("CANDIDATE_RESULT: "):
            return json.loads(line[len("CANDIDATE_RESULT: "):])
    if action == "render":
        return {}
    raise ValueError("Candidate command did not return its saved subtitle revision")


def update_record(clip, result, api):
    for key in ("candidateSrtPath", "candidateSrtSha256", "candidateRevision"):
        clip[key] = result[key]
    if "reviewPreview" in result:
        clip["reviewPreview"] = result["reviewPreview"]
    clip["title"] = result["copy"].get("title", "")
    clip["description"] = result["copy"].get("description", "")
    if "pendingRebuild" in result:
        clip["pendingRebuild"] = result["pendingRebuild"]
        clip["publicCopyPending"] = bool(result.get("publicCopyPending"))
        clip["subtitleRevisionKind"] = "own_stream"
        if result["pendingRebuild"]:
            clip["reviewPending"] = True
            clip["reviewIssues"] = ["subtitle_revision_needs_render"]
            if clip.get("status") != "uploaded":
                clip["status"] = "pending_rebuild"
    clip["updatedAt"] = api.now_iso()


def active_ids(queue):
    return {int(i) for job in queue.get("jobs", []) if job.get("status") in ("pending", "running", "retry_wait")
            for i in job.get("clipIds", [])}


def preview_candidates(args, api):
    ids = api.parse_int_list(args.ids)
    if not ids:
        print("[ERROR] --ids is required", file=sys.stderr)
        return 2
    failures = 0
    for clip_id in ids:
        try:
            # Do not hold the global queue mutation lock across FFmpeg. The
            # candidate process uses its own lock; only the registry merge is global.
            registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
            clip = registry.get("clips", {}).get(str(clip_id))
            if not clip or not clip.get("pendingCut") or is_published(clip):
                raise ValueError("Preview requires an unrendered topic candidate")
            if clip_id in active_ids(api.load_json(api.QUEUE_PATH, api.default_queue())):
                raise ValueError("The upload worker owns this ID")
            result = candidate_action(api, clip, "preview", timeout=args.timeout_seconds)
            handle = api.acquire_queue_mutation_lock()
            try:
                latest = api.load_json(api.REGISTRY_PATH, api.default_registry())
                current = latest["clips"][str(clip_id)]
                # Preview never changes approval, upload paths or queue status.
                current["reviewPreview"] = result["reviewPreview"]
                for key in ("candidateSrtPath", "candidateSrtSha256", "candidateRevision"):
                    if not current.get(key):
                        current[key] = result[key]
                api.save_json(api.REGISTRY_PATH, latest)
            finally:
                api.release_queue_mutation_lock(handle)
            print(f"[OK] {clip_id}: rough preview | {result['reviewPreview']['mediaPath']}")
            print(f"       SRT | {result['reviewPreview']['srtPath']}")
        except (OSError, ValueError, api.subprocess.TimeoutExpired) as error:
            failures += 1
            print(f"[ERROR] {clip_id}: {error}", file=sys.stderr)
    return 2 if failures else 0


def edit_candidate(args, api):
    clip_id = int(args.id)
    action = "correct" if args.cmd == "correct" else "draft"
    note = getattr(args, "note", "") or "User-requested literal subtitle correction"
    signature = {"from": getattr(args, "from_text", None), "to": getattr(args, "to_text", None),
                 "cue": getattr(args, "cue", None)}
    handle = api.acquire_queue_mutation_lock()
    try:
        registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
        clip = registry.get("clips", {}).get(str(clip_id))
        if clip and not clip.get("pendingCut") and action == "draft":
            metadata = api.load_json(Path(clip.get("metadataPath") or ""), {})
            if metadata.get("renderedSubtitles"):
                result = candidate_action(api, clip, "draft", timeout=120)
                print(f"[OK] {clip_id}: current SRT revision {result['candidateRevision']} | {result['candidateSrtPath']}")
                for cue in result["cues"]:
                    print(f"{cue['number']:>3} | {cue['start']:.3f}-{cue['end']:.3f} | {cue['text']}")
                return 0
            srt_path = Path((metadata.get("output") or {}).get("srtPath") or clip.get("srtPath") or "")
            if not srt_path.is_file():
                raise ValueError(f"{clip_id}: rendered clip SRT is missing")
            print(f"[OK] {clip_id}: rendered clip SRT | {srt_path}")
            print(srt_path.read_text(encoding="utf-8-sig"))
            return 0
        if not clip:
            raise ValueError(f"Unknown clip ID: {clip_id}")
        api.sync_clip_statuses(registry, [clip_id])
        if getattr(args, "enqueue", False) and is_published(clip):
            raise ValueError("Already published: rebuild locally and replace the original submission; do not enqueue a duplicate")
        queue = api.load_json(api.QUEUE_PATH, api.default_queue())
        if action == "correct" and clip_id in active_ids(queue):
            if getattr(args, "enqueue", False) and clip.get("lastCandidateCorrection") == signature:
                print(f"[OK] {clip_id}: this correction is already queued")
                return 0
            raise ValueError(f"{clip_id} is already queued or rendering; cannot change its approved subtitles")
        options = {"review_note": note}
        if action == "correct":
            options.update(signature)
        result = candidate_action(api, clip, action, options, timeout=120)
        update_record(clip, result, api)
        if action == "correct":
            clip["lastCandidateCorrection"] = signature
        api.save_json(api.REGISTRY_PATH, registry)
    except (OSError, ValueError, api.subprocess.TimeoutExpired) as error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 2
    finally:
        api.release_queue_mutation_lock(handle)
    print(f"[OK] {clip_id}: SRT revision {result['candidateRevision']} | {result['candidateSrtPath']}")
    if action == "draft":
        for cue in result["cues"]:
            print(f"{cue['number']:>3} | {cue['start']:.3f}-{cue['end']:.3f} | {cue['text']}")
    if getattr(args, "enqueue", False):
        enqueue_args = api.build_parser().parse_args(["enqueue", "--ids", str(clip_id), "--note", note])
        enqueue_args.expected_candidate_drafts = {str(clip_id): result["candidateSrtSha256"]}
        return api.enqueue(enqueue_args)
    return 0


def approve_for_queue(api, registry, ids, note, expected=None):
    """Only filesystem preparation: called under the short queue mutation lock."""
    snapshots = {}
    for clip_id in ids:
        clip = registry["clips"][str(clip_id)]
        if not clip.get("pendingCut") and not clip.get("pendingRebuild"):
            continue
        if expected and expected.get(str(clip_id)) != clip.get("candidateSrtSha256"):
            raise ValueError(f"{clip_id}: candidate changed after correction; not queued")
        result = candidate_action(api, clip, "approve", {"review_note": note or "User requested upload by candidate ID"}, timeout=120)
        update_record(clip, result, api)
        snapshots[str(clip_id)] = {"sha256": result["candidateSrtSha256"], "revision": result["candidateRevision"],
                                  "kind": "candidate" if clip.get("pendingCut") else "own_stream"}
    return snapshots


def is_published(clip):
    return clip.get("status") == "uploaded" or bool((clip.get("uploadState") or {}).get("bvid"))


def prepare_rebuild(args, api):
    handle = api.acquire_queue_mutation_lock()
    try:
        registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
        clip = registry.get("clips", {}).get(str(args.id))
        if not clip or clip.get("pendingCut"):
            raise ValueError("A rendered clip ID is required; unrendered keyword candidates use cut")
        api.sync_clip_statuses(registry, [args.id])
        if args.id in active_ids(api.load_json(api.QUEUE_PATH, api.default_queue())):
            raise ValueError("The upload worker owns this ID; cancel its waiting job before editing")
        if args.enqueue and is_published(clip):
            raise ValueError("Already published: local rebuild only; duplicate upload is not allowed")
        options = {key: getattr(args, key, None) for key in (
            "review_note", "title", "description", "cover_text", "source_kind", "start", "end", "duration_note", "xml")}
        options["allow_long"] = "yes" if args.allow_long else None
        result = candidate_action(api, clip, "prepare", options, timeout=120)
        update_record(clip, result, api)
        api.save_json(api.REGISTRY_PATH, registry)
    except (OSError, ValueError, api.subprocess.TimeoutExpired) as error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 2
    finally:
        api.release_queue_mutation_lock(handle)
    print(f"[OK] {args.id}: rebuild prepared; no media rendered or uploaded")
    if args.enqueue:
        command = api.build_parser().parse_args(["enqueue", "--ids", str(args.id), "--note", args.review_note])
        command.expected_candidate_drafts = {str(args.id): result["candidateSrtSha256"]}
        return api.enqueue(command)
    return 0


def cut_candidates(args, api):
    ids = api.parse_int_list(args.ids)
    if not ids or not str(args.review_note or "").strip():
        print("[ERROR] candidate IDs and --review-note are required", file=sys.stderr)
        return 2
    overrides = {field: getattr(args, field, None) for field in ("title", "description", "cover_text")}
    if len(ids) != 1 and any(value is not None for value in overrides.values()):
        print("[ERROR] copy overrides require exactly one candidate", file=sys.stderr)
        return 2
    for clip_id in ids:
        registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
        clip = registry.get("clips", {}).get(str(clip_id))
        if not clip or not clip.get("metadataPath"):
            print(f"[ERROR] unknown JSON candidate: {clip_id}", file=sys.stderr)
            return 2
        if not clip.get("pendingCut") and not clip.get("pendingRebuild"):
            if clip.get("reviewPending") and not clip.get("mediaPath"):
                print(f"[ERROR] {clip_id} is an unrendered/rejected own-stream candidate; inspect its source and rejection reason, then re-plan a valid window before rendering", file=sys.stderr)
                return 2
            print(f"[OK] {clip_id} is already rendered ({clip.get('status')}); not cutting again")
            continue
        try:
            rebuilding = bool(clip.get("pendingRebuild"))
            options = {"review_note": args.review_note, **overrides}
            if rebuilding and any(value is not None for value in overrides.values()):
                raise ValueError("Use rebuild to save revision public-copy changes before cut")
            if getattr(args, "require_approval", False):
                expected = args.candidate_subtitles.get(str(clip_id), {}).get("sha256")
                if not expected:
                    raise ValueError(f"{clip_id}: upload job lacks an approved subtitle snapshot; enqueue again")
                options.update(require_approval="yes", expected_sha256=expected)
            elif clip_id in active_ids(api.load_json(api.QUEUE_PATH, api.default_queue())):
                raise ValueError(f"{clip_id} is owned by the upload worker")
            print(f"[worker] candidate {clip_id}: burning subtitles and generating cover", flush=True)
            candidate_action(api, clip, "render", options, timeout=getattr(args, "timeout_seconds", 1800))
            metadata_path = Path(clip["metadataPath"])
            if not rebuilding and getattr(args, "require_approval", False):
                metadata = api.load_json(metadata_path, {})
                output = metadata.get("output") or {}
                audit = api.subprocess.run([sys.executable, str(api.PROJECT_ROOT / "src/scripts/audit_bilibili_clip.py"),
                    "--video", output.get("mediaPath", ""), "--srt", output.get("srtPath", ""),
                    "--metadata", str(metadata_path), "--cover", output.get("coverPath", "")],
                    cwd=api.PROJECT_ROOT, capture_output=True, encoding="utf-8", errors="replace", timeout=120,
                    **api.hidden_subprocess_kwargs())
                if audit.returncode:
                    raise ValueError((audit.stdout or "") + (audit.stderr or ""))
            imported = api.import_json(argparse.Namespace(
                manifest=str(metadata_path), review=clip["reviewPath"] if rebuilding else str(metadata_path.with_name(metadata_path.stem + "_MANUAL_REVIEW.md")),
                state=clip["statePath"] if rebuilding else str(metadata_path.with_name(metadata_path.stem + "_upload_state.json")),
                source="", tags="", prefix="", tid=None, label="", batch_id=""))
            if imported:
                return imported
            print(f"[OK] {clip_id}: rendered and registered under the same ID", flush=True)
        except (OSError, ValueError, api.subprocess.TimeoutExpired) as error:
            handle = api.acquire_queue_mutation_lock()
            try:
                latest = api.load_json(api.REGISTRY_PATH, api.default_registry())
                latest["clips"][str(clip_id)]["candidateError"] = str(error)
                api.save_json(api.REGISTRY_PATH, latest)
            finally:
                api.release_queue_mutation_lock(handle)
            print(f"[ERROR] candidate {clip_id}: {error}", file=sys.stderr, flush=True)
            return 2
    return 0


def render_for_job(api, registry, queue, job, pending_ids):
    candidates = [i for i in pending_ids if registry["clips"][str(i)].get("pendingCut")
                  or registry["clips"][str(i)].get("pendingRebuild")]
    if not candidates:
        return registry, queue
    handle = api.acquire_queue_mutation_lock()
    try:
        registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
        queue = api.load_json(api.QUEUE_PATH, api.default_queue())
        job = api.find_queue_job(queue, job["id"]) or job
        api.mark_job(job, "running", phase="rendering", startedAt=api.now_iso())
        for clip_id in candidates:
            registry["clips"][str(clip_id)]["status"] = "rendering"
        api.save_json(api.REGISTRY_PATH, registry)
        api.save_json(api.QUEUE_PATH, queue)
    finally:
        api.release_queue_mutation_lock(handle)
    for clip_id in candidates:
        result = api.cut_candidates(argparse.Namespace(ids=str(clip_id),
            review_note=job.get("note") or "User requested upload by candidate ID", require_approval=True,
            candidate_subtitles=job.get("candidateSubtitles", {}), timeout_seconds=job.get("timeoutSeconds", 1800)))
        # Persist each failure immediately. Later candidates and ready media can
        # continue, while retries/recovery must never revive a rejected revision.
        handle = api.acquire_queue_mutation_lock()
        try:
            registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
            queue = api.load_json(api.QUEUE_PATH, api.default_queue())
            current = api.find_queue_job(queue, job["id"]) or job
            if result:
                reason = registry["clips"][str(clip_id)].get("candidateError") or "Candidate rendering or subtitle validation failed; correct and enqueue again"
                current.setdefault("renderFailures", {})[str(clip_id)] = reason
                api.set_unfinished_clip_statuses(registry, [clip_id], "failed", reason)
                print(f"[worker] candidate {clip_id} failed; continuing other IDs: {reason}", file=sys.stderr, flush=True)
            else:
                registry["clips"][str(clip_id)].pop("candidateError", None)
            current["clipStatuses"] = api.clip_status_map(registry, current["clipIds"])
            api.save_json(api.REGISTRY_PATH, registry)
            api.save_json(api.QUEUE_PATH, queue)
        finally:
            api.release_queue_mutation_lock(handle)
    registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
    queue = api.load_json(api.QUEUE_PATH, api.default_queue())
    current = api.find_queue_job(queue, job["id"]) or job
    current["phase"] = "uploading"
    queue = api.commit_queue_snapshot(queue, job_ids=(job["id"],))
    return registry, queue


def uploadable_job_ids(job):
    failures = job.get("renderFailures", {})
    return [int(i) for i in job.get("clipIds", []) if str(i) not in failures]


def finish_job(api, registry, job, **extra):
    failures = job.get("renderFailures", {})
    api.clear_job_retry_metadata(job)
    api.mark_job(job, "failed" if failures else "done",
        clipStatuses=api.clip_status_map(registry, job["clipIds"]), **extra,
        **({"error": "; ".join(f"ID {i}: {reason}" for i, reason in failures.items())} if failures else {}))
