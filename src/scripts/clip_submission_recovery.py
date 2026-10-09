"""Reconcile a bound submission attempt before the queue may submit it again."""

import datetime as dt
import hashlib
import os


class SubmissionRecoveryPending(RuntimeError):
    pass


class SubmissionRecoveryConflict(ValueError):
    pass


def same_media(left, right):
    return bool(left and right and os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right)))


def intent_key(clip):
    path = os.path.normcase(os.path.abspath(clip.get("path") or ""))
    return "media:" + hashlib.sha256(path.encode()).hexdigest()


def find_intent(state, clip):
    intents = state.get("submission_intents", {})
    bound_key = intent_key(clip)
    if bound_key in intents and (not isinstance(intents[bound_key], dict)
            or not same_media(intents[bound_key].get("mediaPath"), clip.get("path"))):
        raise SubmissionRecoveryConflict("submission recovery conflict: bound attempt media is invalid")
    for key in (bound_key, str(clip["idx"])):
        intent = intents.get(key)
        if isinstance(intent, dict) and same_media(intent.get("mediaPath"), clip.get("path")):
            return key, intent
    return None, None


def clear_intent(state, clip):
    key, _ = find_intent(state, clip)
    if key is not None:
        del state["submission_intents"][key]


def validate_queue_submission(clip, job_id, api=None):
    """Manual authorization stays distinct from configured automatic authority."""
    if api is None:
        try:
            from . import clip_upload_registry as api
        except ImportError:
            import clip_upload_registry as api
    queue = api.load_json(api.QUEUE_PATH, api.default_queue())
    job = api.find_queue_job(queue, job_id)
    if not job or job.get("status") != "running" or job.get("allowDuplicateTitle"):
        raise SubmissionRecoveryConflict("submission recovery authorization invalid: job is not running or allows duplicates")
    registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
    matches = [registry.get("clips", {}).get(str(i)) for i in job.get("clipIds", [])]
    matches = [row for row in matches if row and same_media(row.get("mediaPath"), clip.get("path"))
        and same_media(row.get("metadataPath"), clip.get("metadataPath"))
        and int(row.get("reviewIndex") or 0) == int(clip["idx"])]
    if len(matches) != 1 or matches[0].get("status") == "uploaded":
        raise SubmissionRecoveryConflict("submission recovery authorization invalid: clip identity changed")
    if any(clip.get(key) is not None and clip.get(key) != matches[0].get(key)
            for key in ("title", "prefix", "source", "tags", "tid")):
        raise SubmissionRecoveryConflict("submission recovery authorization invalid: public copy changed")
    errors = api.validate_groups([matches])
    if errors:
        raise SubmissionRecoveryConflict("submission recovery authorization invalid: " + "; ".join(errors))
    if job.get("automaticPublication"):
        api.clip_auto_publication.validate_submission_authorization(clip, job_id, api)
    return matches[0]["id"]


def absence_receipt(intent, title, rows, now):
    if intent.get("title") != title:
        raise SubmissionRecoveryConflict("submission recovery conflict: prior title changed; inspect the existing attempt")
    try:
        started = dt.datetime.fromisoformat(intent["startedAt"].replace("Z", "+00:00"))
        if started.tzinfo is None:
            raise ValueError("missing timezone")
    except (KeyError, TypeError, ValueError) as error:
        raise SubmissionRecoveryConflict("submission recovery conflict: prior attempt time is missing") from error
    if (now - started).total_seconds() < 300:
        raise SubmissionRecoveryPending("submission outcome unknown: wait five minutes before archive reconciliation")
    if not isinstance(rows, list) or any(not isinstance(row, dict) or not row.get("title") or not row.get("bvid") for row in rows):
        raise SubmissionRecoveryPending("submission outcome unknown: archive lookup is incomplete")
    matches = [row for row in rows if row["title"] == title]
    if matches:
        raise SubmissionRecoveryConflict("submission recovery conflict: title exists online; verify its media instead of resubmitting")
    times = [int(row.get("pubdate") or 0) for row in rows]
    if rows and (any(value <= 0 for value in times) or min(times) > started.timestamp()):
        raise SubmissionRecoveryPending("submission outcome unknown: archive lookup does not cover the attempt")
    return {"version": 1, "method": "bound_attempt_and_member_archives", "result": "no_matching_archive",
        "checkedAt": now.isoformat(), "title": title, "archiveRows": len(rows), "oldestArchiveAt": min(times) if times else None}


def reconcile_intent(state, clip, title, job_id, lookup, authorize=validate_queue_submission, now=None):
    key, intent = find_intent(state, clip)
    if intent is None:
        return False
    if not job_id:
        raise SubmissionRecoveryPending("submission outcome unknown: recovery requires a running authorized queue job")
    clip_id = authorize(clip, job_id)
    now = now or dt.datetime.now(dt.timezone.utc)
    # Avoid an API call while the archive can still be settling.
    absence_receipt(intent, title, [], now)
    receipt = absence_receipt(intent, title, lookup(), now)
    authorize(clip, job_id)  # Cancellation/review changes during IO revoke recovery.
    state.setdefault("reconciled_submission_intents", []).append({"reviewIndex": str(clip["idx"]),
        "intent": intent, "clipId": clip_id, "replacementJobId": job_id, "reconciliation": receipt})
    del state["submission_intents"][key]
    return True
