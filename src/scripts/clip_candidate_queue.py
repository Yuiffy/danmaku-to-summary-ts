"""Candidate subtitle commands and the upload worker's render stage."""

import argparse
import json
import sys
from pathlib import Path


def candidate_action(api, clip, action, options=None, timeout=1800):
    command = ["node", str(api.PROJECT_ROOT / "src/scripts/render_topic_candidate.js"),
               "--metadata", clip["metadataPath"], "--candidate-id", str(clip["id"]), "--action", action]
    review = clip.get("candidateReviewPath") or clip.get("reviewPath")
    if review:
        command.extend(["--registry-path", str(api.REGISTRY_PATH), "--source-review", review])
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
    clip["title"] = result["copy"].get("title", "")
    clip["description"] = result["copy"].get("description", "")
    clip["updatedAt"] = api.now_iso()


def active_ids(queue):
    return {int(i) for job in queue.get("jobs", []) if job.get("status") in ("pending", "running", "retry_wait")
            for i in job.get("clipIds", [])}


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
        if not clip or not clip.get("pendingCut"):
            raise ValueError(f"{clip_id} is not an unrendered candidate")
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
        if not clip.get("pendingCut"):
            continue
        if expected and expected.get(str(clip_id)) != clip.get("candidateSrtSha256"):
            raise ValueError(f"{clip_id}: candidate changed after correction; not queued")
        result = candidate_action(api, clip, "approve", {"review_note": note or "User requested upload by candidate ID"}, timeout=120)
        update_record(clip, result, api)
        snapshots[str(clip_id)] = {"sha256": result["candidateSrtSha256"], "revision": result["candidateRevision"]}
    return snapshots


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
        if not clip.get("pendingCut"):
            print(f"[OK] {clip_id} is already rendered ({clip.get('status')}); not cutting again")
            continue
        try:
            options = {"review_note": args.review_note, **overrides}
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
            if getattr(args, "require_approval", False):
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
                manifest=str(metadata_path), review=str(metadata_path.with_name(metadata_path.stem + "_MANUAL_REVIEW.md")),
                state=str(metadata_path.with_name(metadata_path.stem + "_upload_state.json")),
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
    candidates = [i for i in pending_ids if registry["clips"][str(i)].get("pendingCut")]
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
    result = api.cut_candidates(argparse.Namespace(ids=",".join(map(str, candidates)),
        review_note=job.get("note") or "User requested upload by candidate ID", require_approval=True,
        candidate_subtitles=job.get("candidateSubtitles", {}), timeout_seconds=job.get("timeoutSeconds", 1800)))
    registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
    queue = api.load_json(api.QUEUE_PATH, api.default_queue())
    current = api.find_queue_job(queue, job["id"]) or job
    if result:
        reason = "; ".join(registry["clips"][str(i)].get("candidateError", "") for i in candidates).strip("; ")
        reason = reason or "Candidate rendering or subtitle validation failed; correct and enqueue again"
        api.set_unfinished_clip_statuses(registry, pending_ids, "failed", reason)
        api.mark_job(current, "failed", phase="rendering", error=reason)
        api.save_json(api.REGISTRY_PATH, registry)
        api.commit_queue_snapshot(queue, job_ids=(job["id"],))
        return None
    current["phase"] = "uploading"
    queue = api.commit_queue_snapshot(queue, job_ids=(job["id"],))
    return registry, queue
