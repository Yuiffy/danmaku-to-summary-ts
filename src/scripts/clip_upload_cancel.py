"""Locked operator cancellation and cooperative uploader interruption."""

import asyncio
import copy
import sys
from pathlib import Path


class UploadCancelled(RuntimeError):
    pass


def requested_ids(job):
    return {int(i) for i in job.get("cancellationRequests", {})}


def remaining_ids(job):
    return [int(i) for i in job.get("clipIds", []) if int(i) not in requested_ids(job)]


def merge_job(existing, replacement):
    """Worker snapshots cannot withdraw a later operator cancellation/submit gate."""
    for field in ("cancellationRequests", "submissionStartedClipIds", "cancellationAcknowledgedIds", "cancellationWholeJob"):
        if field in existing:
            replacement[field] = copy.deepcopy(existing[field])
    if existing.get("status") == "cancelled":
        return copy.deepcopy(existing)
    return replacement


def acknowledge_locked(api, registry, job, ids):
    """Apply acknowledgements inside an existing short queue transaction."""
    selected = requested_ids(job).intersection(ids)
    if not selected:
        return False
    acknowledged = set(job.get("cancellationAcknowledgedIds", []))
    for clip_id in selected:
        clip = registry["clips"][str(clip_id)]
        api.sync_clip_statuses(registry, [clip_id])
        if clip.get("status") != "uploaded" and (clip.get("uploadCancellation") or {}).get("jobId") == job["id"]:
            clip.update(status="review", updatedAt=api.now_iso())
            clip.pop("failureReason", None)
        acknowledged.add(clip_id)
    job["cancellationAcknowledgedIds"] = sorted(acknowledged)
    job["clipStatuses"] = api.clip_status_map(registry, job["clipIds"])
    unfinished = [i for i in remaining_ids(job) if registry["clips"][str(i)].get("status") != "uploaded"
                  and str(i) not in job.get("renderFailures", {})]
    if not unfinished and requested_ids(job).issubset(acknowledged) and (job.get("cancellationWholeJob") or not remaining_ids(job)):
        api.clear_job_retry_metadata(job)
        api.mark_job(job, "cancelled", cancelledAt=api.now_iso(),
                     cancellationReason="; ".join(sorted({r["reason"] for r in job["cancellationRequests"].values()})))
    return True


def acknowledge(api, job_id, ids):
    """Release IDs only after their renderer/uploader has stopped touching them."""
    if not ids:
        return
    with api.queue_transaction() as queue:
        job = api.find_queue_job(queue, job_id)
        if not job or not requested_ids(job).intersection(ids):
            return
        registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
        acknowledge_locked(api, registry, job, ids)
        api.save_json(api.REGISTRY_PATH, registry)


def cancel(args, api):
    """Cancel one clip or a complete job without acquiring the lifetime worker lock."""
    try:
        with api.queue_transaction() as queue:
            registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
            clip_ids = api.parse_int_list(args.ids) if getattr(args, "ids", None) else None
            job_id = getattr(args, "job", None)
            jobs = [job for job in queue.get("jobs", []) if job.get("id") == job_id] if job_id else [
                job for job in queue.get("jobs", []) if job.get("status") in ("pending", "retry_wait", "blocked", "running")
                and {int(i) for i in job.get("clipIds", []) if int(i) not in job.get("cancellationAcknowledgedIds", [])}.intersection(clip_ids or [])]
            if not jobs:
                raise ValueError("No cancellable upload job found")
            affected = []
            for job in jobs:
                if job.get("status") == "cancelled":
                    continue
                if job.get("status") not in ("pending", "retry_wait", "blocked", "running"):
                    raise ValueError(f"Cannot cancel job from {job.get('status')}")
                if job_id:
                    job["cancellationWholeJob"] = True
                selected = [int(i) for i in job.get("clipIds", []) if clip_ids is None or int(i) in clip_ids]
                api.sync_clip_statuses(registry, selected)
                for clip_id in selected:
                    clip = registry.get("clips", {}).get(str(clip_id))
                    if not clip:
                        raise ValueError(f"Missing registry ID {clip_id}")
                    if clip.get("status") == "uploaded":
                        if clip_ids is not None:
                            raise ValueError(f"ID {clip_id} is already submitted; cancellation cannot recall it")
                        continue
                    if clip_id in job.get("submissionStartedClipIds", []):
                        raise ValueError(f"ID {clip_id}: submission has started; verify the receipt before retrying")
                    if str(clip_id) in job.get("cancellationRequests", {}):
                        affected.append((job["id"], clip_id, job.get("status") != "running"
                                         or clip_id in job.get("cancellationAcknowledgedIds", [])))
                        continue
                    # An interrupted submit may have no receipt yet; retain its reconciliation guard.
                    state = api.load_json(Path(clip["statePath"]), {}) if clip.get("statePath") else {}
                    intents = (state.get("submission_intents") or {}).values()
                    has_intent = any(isinstance(intent, dict) and api.paths_match(intent.get("mediaPath", ""), clip.get("mediaPath", "")) for intent in intents)
                    if job.get("status") != "running" and has_intent:
                        raise ValueError(f"ID {clip_id}: submission outcome needs reconciliation before cancellation")
                    request = job.setdefault("cancellationRequests", {}).setdefault(str(clip_id),
                        {"at": api.now_iso(), "reason": str(args.note or "").strip()})
                    clip["uploadCancellation"] = {**request, "jobId": job["id"]}
                    clip.update(status="cancelling", updatedAt=api.now_iso())
                    job["updatedAt"] = api.now_iso()
                    affected.append((job["id"], clip_id, job.get("status") != "running"))
            if clip_ids is not None and set(clip_ids) - {i for _, i, _ in affected}:
                raise ValueError("Some selected IDs have no cancellable job")
            api.save_json(api.REGISTRY_PATH, registry)
        for job_id, clip_id, idle in affected:
            if idle:
                acknowledge(api, job_id, [clip_id])
        print("[OK] cancellation saved; active uploads stop before submission; clips remain editable after acknowledgement")
        return 0
    except (OSError, ValueError, KeyError) as error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 2


class UploadControl:
    """Bind a queue job/media to a synchronous submit gate and async abort watcher."""
    def __init__(self, job_id, media, api=None):
        if api is None:
            try:
                from . import clip_upload_registry as api
            except ImportError:
                import clip_upload_registry as api
        self.api, self.job_id, self.media = api, job_id, media
        self.submitting = False

    def identity(self, queue, registry):
        job = self.api.find_queue_job(queue, self.job_id)
        matches = [int(i) for i in (job or {}).get("clipIds", [])
                   if self.api.paths_match(registry.get("clips", {}).get(str(i), {}).get("mediaPath", ""), self.media)]
        if not job or len(matches) != 1:
            raise UploadCancelled("Upload job/media identity no longer exists")
        return job, matches[0]

    def check(self):
        queue = self.api.load_json(self.api.QUEUE_PATH, self.api.default_queue())
        registry = self.api.load_json(self.api.REGISTRY_PATH, self.api.default_registry())
        job, clip_id = self.identity(queue, registry)
        if job.get("status") == "cancelled" or clip_id in requested_ids(job):
            raise UploadCancelled("[UPLOAD_CANCELLED] Operator cancelled this clip")

    def uploader_type(self, base):
        control = self

        class CancellableUploader(base):
            async def _submit(self, *args, **kwargs):
                # Linearize cancellation with the irreversible archive submission boundary.
                with control.api.queue_transaction() as queue:
                    registry = control.api.load_json(control.api.REGISTRY_PATH, control.api.default_registry())
                    job, clip_id = control.identity(queue, registry)
                    if clip_id in requested_ids(job) or job.get("status") != "running":
                        raise UploadCancelled("[UPLOAD_CANCELLED] Cancelled before submission")
                    started = job.setdefault("submissionStartedClipIds", [])
                    if clip_id not in started:
                        started.append(clip_id)
                    control.submitting = True
                return await super()._submit(*args, **kwargs)

        return CancellableUploader

    def rejected(self):
        """A known server rejection releases the submit gate, retaining ordinary retry rules."""
        with self.api.queue_transaction() as queue:
            registry = self.api.load_json(self.api.REGISTRY_PATH, self.api.default_registry())
            job, clip_id = self.identity(queue, registry)
            job["submissionStartedClipIds"] = [i for i in job.get("submissionStartedClipIds", []) if i != clip_id]

    async def run(self, uploader, progress):
        self.check()
        task = asyncio.create_task(progress.run(uploader))
        try:
            while not task.done():
                await asyncio.wait({task}, timeout=0.5)
                if not task.done() and not self.submitting:
                    try:
                        self.check()
                    except UploadCancelled:
                        await uploader.abort()
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
                        raise
            return await task
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
