"""Resolve queued uploads by stable registry IDs, independently of batch exports."""

import copy


def load_queued_upload_clips(ids_text, job_id, *, api=None):
    """Read one running job's current records; this never grants upload authority."""
    if api is None:
        try:
            from . import clip_upload_registry as api
        except ImportError:
            import clip_upload_registry as api
    ids = [int(value.strip()) for value in str(ids_text or "").split(",") if value.strip()]
    if not job_id or not ids or min(ids) < 1 or len(set(ids)) != len(ids):
        raise ValueError("queue input requires a job and unique positive clip IDs")
    handle = api.acquire_queue_mutation_lock()
    try:
        queue = api.load_json(api.QUEUE_PATH, api.default_queue())
        registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
        job = api.find_queue_job(queue, job_id)
        if not job or job.get("status") != "running":
            raise ValueError("queue input job is not running")
        members = {int(value) for value in job.get("clipIds", [])}
        cancelled = {int(value) for value in job.get("cancellationRequests", {})}
        clips = []
        for clip_id in ids:
            clip = registry.get("clips", {}).get(str(clip_id))
            if clip_id not in members or clip is None:
                raise ValueError(f"queue input ID {clip_id} does not belong to the job/registry")
            if clip_id in cancelled or clip.get("uploadCancellation"):
                raise ValueError(f"queue input ID {clip_id} upload was cancelled")
            if clip.get("status") == "uploaded" and not job.get("allowDuplicateTitle"):
                raise ValueError(f"queue input ID {clip_id} was already uploaded")
            clips.append(copy.deepcopy(clip))
    finally:
        api.release_queue_mutation_lock(handle)
    if len({api.clip_batch_key(clip) for clip in clips}) != 1:
        raise ValueError("queue input IDs must belong to one upload group")
    indices = [int(clip["reviewIndex"]) for clip in clips]
    if len(set(indices)) != len(indices):
        raise ValueError("queue input has ambiguous review indices")
    errors = api.validate_groups([clips])
    if errors:
        raise ValueError("; ".join(errors))
    return [{**clip, "idx": int(clip["reviewIndex"]), "path": clip["mediaPath"],
             "cover": clip.get("coverPath") or ""} for clip in clips]
