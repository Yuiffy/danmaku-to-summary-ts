"""Explicit reconciliation of a terminal automatic attempt before a fresh enqueue."""
import datetime as dt
import hashlib
import json
from pathlib import Path


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def prior_attempt(clip, metadata, prior, jobs, now):
    """Validate the old bound snapshot; it does not approve the repaired artifact."""
    authorization = clip.get("automaticPublicationAuthorization") or {}
    if authorization.get("clipId") != clip["id"] or authorization.get("authority") != "configured_policy":
        raise ValueError("missing prior automatic authorization for this ID")
    if clip.get("reviewIssues") != ["automatic publication source identity changed"]:
        raise ValueError("automatic retry only resolves the old source identity hold")
    if Path(prior.get("output", {}).get("metadataPath", "")).resolve() != Path(clip["metadataPath"]).resolve():
        raise ValueError("prior metadata belongs to a different ID")
    for field, key in (("publicationReview", "reviewDigest"), ("publicationDecision", "decisionDigest"), ("upload", "uploadDigest")):
        if digest(prior.get(field)) != authorization.get(key):
            raise ValueError("prior metadata does not match the saved automatic authorization")
    copy = prior.get("copy") or {}
    copy_hash = hashlib.sha256("\0".join(str(copy.get(key, "")) for key in ("title", "coverText", "description")).encode()).hexdigest()
    if copy_hash != prior["publicationReview"]["digests"]["copy"]:
        raise ValueError("prior submitted title is not bound to its saved review")
    attempts = [job for job in jobs if clip["id"] in job.get("clipIds", [])
        and job.get("automaticPublicationAuthorizations", {}).get(str(clip["id"])) == authorization]
    if not attempts or any(job.get("status") not in ("failed", "blocked", "cancelled") for job in attempts):
        raise ValueError("prior automatic attempt must be terminal and inactive")
    started = [dt.datetime.fromisoformat(str(job.get("startedAt") or job.get("createdAt")).replace("Z", "+00:00")) for job in attempts]
    latest = [dt.datetime.fromisoformat(str(job.get("finishedAt") or job.get("updatedAt")
        or job.get("startedAt") or job.get("createdAt")).replace("Z", "+00:00")) for job in attempts]
    if any(value.tzinfo is None for value in started + latest) or (now - max(latest + started)).total_seconds() < 300:
        raise ValueError("wait at least five minutes before reconciling an unknown automatic attempt")
    title = lambda row: str((row.get("upload") or {}).get("prefix", "")) + str((row.get("copy") or {}).get("title", ""))
    titles = list(dict.fromkeys([title(prior), title(metadata)]))
    if any(not value.strip() for value in titles):
        raise ValueError("both submitted titles are required for reconciliation")
    return {"titles": titles, "startedAt": min(started).timestamp(), "jobIds": [job["id"] for job in attempts],
        "priorAuthorizationDigest": digest(authorization), "priorMediaPath": prior.get("output", {}).get("mediaPath", ""),
        "lastAttemptAt": max(latest + started).isoformat()}


def confirm_archive_absence(details, rows, now):
    """A successful status=all lookup must cover the old attempt before absence is usable."""
    if not isinstance(rows, list) or any(not isinstance(row, dict) or not row.get("title") or not row.get("bvid") for row in rows):
        raise ValueError("archive lookup is incomplete")
    if any(row["title"] in details["titles"] for row in rows):
        raise ValueError("a prior or current title exists online; reconcile its media instead of resubmitting")
    times = [int(row.get("pubdate") or 0) for row in rows if int(row.get("pubdate") or 0) > 0]
    if rows and (not times or min(times) > details["startedAt"]):
        raise ValueError("archive lookup does not cover the prior attempt time")
    return {"version": 1, "method": "bound_prior_review_and_member_archives", "result": "no_matching_archive",
        "checkedAt": now.isoformat(), **details, "archiveRows": len(rows), "oldestArchiveAt": min(times) if times else None}


def lookup_member_archives():
    """Read-only adapter; lookup failures propagate instead of becoming an empty list."""
    try:
        from .batch_upload import fetch_member_archive_rows, find_secrets_path
    except ImportError:
        from batch_upload import fetch_member_archive_rows, find_secrets_path
    secrets = json.loads(Path(find_secrets_path()).read_text(encoding="utf-8-sig"))
    cookie = secrets.get("bilibili", {}).get("cookie", "")
    if not cookie:
        raise ValueError("archive lookup credential unavailable")
    return fetch_member_archive_rows(cookie, pages=5)


def reconcile(clip, metadata, prior_path, jobs, lookup=None):
    prior_bytes = Path(prior_path).read_bytes()
    prior = json.loads(prior_bytes.decode("utf-8-sig"))
    now = dt.datetime.now(dt.timezone.utc)
    details = prior_attempt(clip, metadata, prior, jobs, now)
    receipt = confirm_archive_absence(details, (lookup or lookup_member_archives)(), now)
    return {**receipt, "priorMetadataSha256": hashlib.sha256(prior_bytes).hexdigest()}


def consume_reconciled_intent(state, upload_clip, job_id, api=None):
    """Archive only the exact old intent after validating the live replacement job."""
    if api is None:
        try:
            from . import clip_upload_registry as api
        except ImportError:
            import clip_upload_registry as api
    api.clip_auto_publication.validate_submission_authorization(upload_clip, job_id, api)
    queue = api.load_json(api.QUEUE_PATH, api.default_queue())
    job = api.find_queue_job(queue, job_id)
    registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
    matches = [registry.get("clips", {}).get(str(clip_id)) for clip_id in (job or {}).get("clipIds", [])]
    matches = [clip for clip in matches if clip and api.paths_match(
        clip.get("metadataPath") or "", upload_clip.get("metadataPath") or "")]
    if len(matches) != 1:
        return False
    clip = matches[0]
    receipt = clip.get("automaticPublicationReconciliation") or {}
    if receipt.get("result") != "no_matching_archive" or receipt.get("method") != "bound_prior_review_and_member_archives":
        return False
    history = clip.get("automaticPublicationAuthorizationHistory") or []
    if not any(entry.get("reconciliation") == receipt and digest(entry.get("authorization")) == receipt.get("priorAuthorizationDigest")
               for entry in history if isinstance(entry, dict)):
        return False
    key = str(upload_clip.get("idx"))
    intent = state.get("submission_intents", {}).get(key)
    if (not isinstance(intent, dict) or not receipt.get("titles") or intent.get("title") != receipt["titles"][0]
            or not intent.get("mediaPath") or not receipt.get("priorMediaPath")
            or not api.paths_match(intent["mediaPath"], receipt["priorMediaPath"])):
        return False
    state.setdefault("reconciled_submission_intents", []).append({"reviewIndex": key, "intent": intent,
        "clipId": clip["id"], "replacementJobId": job_id, "reconciliation": receipt})
    del state["submission_intents"][key]
    return True
