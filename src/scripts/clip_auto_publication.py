"""Bound final reviews and durable authorization for ordinary and keyword-topic clips."""

import copy
import datetime as dt
import hashlib
import json
import math
import re
import sys
import time
from contextlib import nullcontext
from pathlib import Path
try:
    from .clip_campaign_policy import resolve_campaign_publication
    from .ordinary_subtitle_evidence import validate_subtitle_audio_evidence, validate_subtitle_diagnostic
    from .clip_source_timing import source_timing_metadata, validate_rendered_timing_repair
except ImportError:
    from clip_campaign_policy import resolve_campaign_publication
    from ordinary_subtitle_evidence import validate_subtitle_audio_evidence, validate_subtitle_diagnostic
    from clip_source_timing import source_timing_metadata, validate_rendered_timing_repair


POLICY_VERSION = "own-stream-v1"
TOPIC_POLICY_VERSION = "topic-v1"
CHECKS = ("content", "attribution", "subtitles", "visuals", "policy")


def file_digest(value):
    digest = hashlib.sha256()
    with Path(value).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def source_snapshot(metadata):
    source = metadata.get("source") or {}
    timing = source_timing_metadata(source.get('srtPath') or '')
    validate_rendered_timing_repair(metadata)
    media = Path(source.get("mediaPath") or "").resolve()
    stat = media.stat()
    original_srt = str(source.get("srtPath") or "")
    if original_srt.lower().endswith(".speaker.srt"):
        original_srt = original_srt[:-len(".speaker.srt")] + ".srt"
    evidence = Path(original_srt).with_suffix(".asr_evidence.json").resolve()
    return {"mediaPath": str(media), "mediaBytes": str(stat.st_size), "mediaMtimeNs": str(stat.st_mtime_ns),
            "srtPath": str(Path(source.get("srtPath") or "").resolve()), "srtSha256": file_digest(source.get("srtPath")),
            "xmlPath": str(Path(source["xmlPath"]).resolve()) if source.get("xmlPath") else None,
            "xmlSha256": file_digest(source["xmlPath"]) if source.get("xmlPath") else None,
            "asrEvidencePath": str(evidence) if evidence.is_file() else None,
            "asrEvidenceSha256": file_digest(evidence) if evidence.is_file() else None, **timing}


def _digest_json(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def publication_identity(metadata):
    """Ignore output/source pathname changes when deduplicating the same recording window."""
    source = source_snapshot(metadata)
    window = metadata.get("window") or {}
    return _digest_json({"roomId": str(metadata.get("roomId") or ""),
                         "source": {key: source[key] for key in ("mediaBytes", "mediaMtimeNs")},
                         "window": {key: float(window[key]) for key in ("start", "end")}})


def optional_publication_identity(metadata):
    try:
        return publication_identity(metadata)
    except (OSError, ValueError, TypeError, KeyError):
        return ""


def _timestamp(value):
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("missing timezone")
        return parsed.astimezone(dt.timezone.utc)
    except (TypeError, ValueError) as error:
        raise ValueError("automatic publication requires valid timestamps with a timezone") from error


def _policy_version(metadata):
    if metadata.get("type"):
        raise ValueError("automatic publication is only supported for ordinary clips")
    if metadata.get("mode") == "own_stream_fun_review" and not metadata.get("publicationKind"):
        return POLICY_VERSION
    if metadata.get("mode") == "local_review" and metadata.get("publicationKind") == "keyword_topic":
        return TOPIC_POLICY_VERSION
    raise ValueError("automatic publication does not authorize this clip mode")


def _topic_mentions(metadata, keywords=None):
    review = metadata.get("aiReview") or {}
    hits = (review.get("keyword") or {}).get("hits")
    bounds = metadata.get("window") or {}
    if not isinstance(hits, list):
        return []
    valid = []
    for hit in hits:
        if not isinstance(hit, dict) or hit.get("verdict") != "mention":
            continue
        start, end = hit.get("start"), hit.get("end")
        words, cue, evidence = hit.get("keywords"), hit.get("cueId"), hit.get("evidenceCueIds")
        if (any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value)
                for value in (start, end)) or start < bounds.get("start", math.inf)
                or end > bounds.get("end", -math.inf) or end <= start
                or any(not isinstance(hit.get(key), str) or not hit[key].strip() for key in ("id", "text", "reason"))
                or not isinstance(cue, str) or not cue.strip() or not isinstance(evidence, list) or cue not in evidence
                or any(not isinstance(value, str) or not value.strip() for value in evidence)
                or not isinstance(words, list) or any(not isinstance(word, str) or not word.strip() for word in words)
                or not any(isinstance(word, str) and word.strip()
                    and (keywords is None or word.strip() in keywords) for word in words)):
            continue
        valid.append(hit)
    return valid


def _validate_topic_review(metadata, review):
    preflight = metadata.get("aiReview") or {}
    editorial = metadata.get("editorial") or {}
    grounding = editorial.get("copyGrounding") or {}
    window = {key: (metadata.get("window") or {}).get(key) for key in ("start", "end")}
    source_kind = editorial.get("sourceKind")
    if (metadata.get("status") != "success" or (metadata.get("source") or {}).get("sourceKind") != "video"
            or preflight.get("version") != 1 or preflight.get("mode") != "preflight"
            or preflight.get("status") != "ready" or preflight.get("applied") is not True
            or preflight.get("window") != window
            or (preflight.get("quality") or {}).get("status") != "pass"
            or (preflight.get("quality") or {}).get("issues") != []
            or (preflight.get("keyword") or {}).get("status") != "confirmed" or not _topic_mentions(metadata)):
        raise ValueError("keyword topic requires a ready, applied preflight and confirmed in-window keyword")
    if (editorial.get("status") != "planned" or editorial.get("copyStatus") != "prepared"
            or source_kind not in ("live_speech", "recount", "playback", "audience")
            or editorial.get("copyWindow") != window or grounding.get("version") != 1
            or grounding.get("status") != "linked" or grounding.get("issues") != []
            or grounding.get("sourceKind") != source_kind
            or not isinstance(preflight.get("sourceSha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", preflight["sourceSha256"])
            or grounding.get("sourceSha256") != preflight["sourceSha256"]):
        raise ValueError("keyword topic editorial evidence is incomplete or changed")
    boundary = preflight.get("boundaryReview")
    if boundary and (boundary.get("status") != "linked" or boundary.get("unresolvedCueIds") != []
                     or boundary.get("issues", []) != []):
        raise ValueError("keyword topic boundary review is unresolved")
    evidence = {key: metadata.get(key) for key in ("publicationKind", "aiReview", "editorial")}
    if review.get("topicEvidence") != evidence:
        raise ValueError("keyword topic evidence changed after final publication review")


def _validate_unresolved_signals(metadata, review):
    if (metadata.get("clipIntent") or {}).get("needsHumanReview"):
        raise ValueError("检测到别切意图，需人工核对语境后决定是否切片")
    proof = metadata.get("subtitleProofreading") or {}
    groups = proof.get("reviewGroups", [])
    resolutions = review.get("resolvedSubtitleAdvisories", [])
    if groups or resolutions:
        window = metadata.get("window") or {}
        if (proof.get("advisory") is not True or not isinstance(groups, list) or not groups
                or review.get("subtitleAdvisoryEvidence") != proof or not isinstance(resolutions, list)
                or len(resolutions) != len(groups)):
            raise ValueError("subtitle advisory resolution is missing or stale")
        indices = []
        for resolution in resolutions:
            if (not isinstance(resolution, dict) or type(resolution.get("groupIndex")) is not int
                    or resolution.get("verdict") != "non_material_playback"
                    or not isinstance(resolution.get("reason"), str) or not resolution["reason"].strip()):
                raise ValueError("invalid subtitle advisory resolution")
            indices.append(resolution["groupIndex"])
        if sorted(indices) != list(range(len(groups))):
            raise ValueError("subtitle advisory resolution does not cover every group")
        for group in groups:
            if (not isinstance(group, dict) or group.get("type") != "possible_foreign_audio"
                    or not isinstance(group.get("occurrences"), list) or not group["occurrences"]):
                raise ValueError("subtitle review group requires original audio verification")
            for row in group["occurrences"]:
                if (not isinstance(row, dict) or not isinstance(row.get("text"), str) or not row["text"].strip()
                        or any(type(row.get(key)) not in (int, float) or not math.isfinite(row[key]) for key in ("start", "end"))
                        or row["end"] <= row["start"] or row["start"] < window.get("start", float('inf')) - 0.01
                        or row["end"] > window.get("end", float('-inf')) + 0.01):
                    raise ValueError("subtitle advisory occurrence is outside the reviewed window")
    audio = metadata.get("audioQa") or {}
    creative = metadata.get("creativeResult") or {}
    if (metadata.get("preRenderHold") or metadata.get("sourceExpansionRequest") or metadata.get("storyRepairRequest")
            or "source_window_incomplete" in str(creative.get("reason") or "")
            or any(item.get("stage") == "source_window_incomplete" for item in creative.get("history", []) if isinstance(item, dict))
            or audio and (audio.get("status") != "passed" or audio.get("issues")
                          or audio.get("listeningReview") not in (None, "", "passed", "not_required"))):
        raise ValueError("unresolved source, subtitle or listening review prevents automatic publication")
    grounding = metadata.get("grounding") or {}
    issues = grounding.get("issues") or []
    resolutions = review.get("resolvedGroundingIssues") or []
    if (not isinstance(issues, list) or not isinstance(resolutions, list)
            or any(issue != "uncertain_source" for issue in issues)
            or grounding.get("status") == "needs_review" and not issues):
        raise ValueError("unresolved grounding prevents automatic publication")
    if "uncertain_source" not in issues:
        if resolutions:
            raise ValueError("unexpected grounding resolution in final publication review")
        return
    resolution = next((item for item in resolutions if isinstance(item, dict) and item.get("issue") == "uncertain_source"), {})
    attribution = metadata.get("attributionReview") or {}
    claims, indices = attribution.get("claims") or [], resolution.get("claimIndexes") or []
    if (attribution.get("status") != "passed" or not str(resolution.get("reason") or "").strip()
            or not isinstance(indices, list) or not indices or not isinstance(claims, list)):
        raise ValueError("uncertain source requires an explicit evidence-backed final resolution")
    for index in indices:
        if not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= len(claims):
            raise ValueError("invalid grounding resolution claim")
        claim = claims[index]
        kind = claim.get("sourceKind")
        evidence = claim.get("evidenceDanmakuIds" if kind == "audience" else "cueIds")
        if kind not in ("live_speech", "recount", "playback", "audience") or not isinstance(evidence, list) or not evidence:
            raise ValueError("grounding resolution claim has no source evidence")


def validate_publication_review(metadata):
    """Verify actual files and source; passing this function alone never queues a clip."""
    review = metadata.get("publicationReview") or {}
    decision = metadata.get("publicationDecision") or {}
    policy_version = _policy_version(metadata)
    if (metadata.get("automaticPublicationRequired") is not True or metadata.get("uploadReady") is not True
            or metadata.get("selectionRejection") or metadata.get("publicCopyPending") or metadata.get("rebuildRequired")):
        raise ValueError("ordinary clip final publication review is required")
    if (review.get("version") != 1 or review.get("policyVersion") != policy_version
            or review.get("status") != "passed" or review.get("issues") != []
            or any((review.get("checks") or {}).get(key) is not True for key in CHECKS)
            or (review.get("technical") or {}).get("passed") is not True
            or (review.get("technical") or {}).get("issues") != []):
        raise ValueError("final publication review has not passed every required check")
    _validate_unresolved_signals(metadata, review)
    if (decision.get("version") != 1 or decision.get("policyVersion") != policy_version
            or decision.get("action") != "auto_queue" or decision.get("reasons") != []):
        raise ValueError("final publication decision does not allow automatic queueing")
    generated = _timestamp(metadata.get("generatedAt"))
    if _timestamp(review.get("reviewedAt")) < generated:
        raise ValueError("final publication review predates the generated artifact")
    if str(review.get("roomId") or "") != str(metadata.get("roomId") or ""):
        raise ValueError("final publication room changed after review")
    window = metadata.get("window") or {}
    bounds = {key: window.get(key) for key in ("start", "end", "duration")}
    if (any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value)
            for value in bounds.values()) or bounds["start"] < 0 or bounds["end"] <= bounds["start"]
            or bounds["duration"] <= 0
            or review.get("artifactWindow") != bounds):
        raise ValueError("final publication source window changed after review")
    if policy_version == TOPIC_POLICY_VERSION:
        _validate_topic_review(metadata, review)
    facts = (review.get("technical") or {}).get("facts") or {}
    if "duration" in facts or "expectedDuration" in facts:
        measured, expected = facts.get("duration"), facts.get("expectedDuration")
        if (any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value <= 0
                for value in (measured, expected)) or expected != bounds["duration"] or abs(measured - expected) > 0.75):
            raise ValueError("technical review duration differs from the final artifact")
    output = metadata.get("output") or {}
    public_copy = metadata.get("copy") or {}
    if (output.get("burnedSubtitles") is not True or output.get("mediaError") or output.get("coverError")
            or output.get("parts") or not all(str(public_copy.get(key) or "").strip()
                                              for key in ("title", "coverText", "description"))):
        raise ValueError("final publication requires burned subtitles and complete public artifacts")
    digests = {"video": file_digest(output.get("mediaPath")), "cover": file_digest(output.get("coverPath")),
               "subtitles": file_digest(output.get("srtPath")),
               "copy": hashlib.sha256("\0".join(str(public_copy.get(key) or "") for key in
                                                ("title", "coverText", "description")).encode()).hexdigest()}
    current_source = source_snapshot(metadata)
    subtitle_audio = validate_subtitle_audio_evidence(metadata, current_source)
    if subtitle_audio:
        digests["subtitleAudio"] = subtitle_audio
    diagnostic = validate_subtitle_diagnostic(metadata, current_source)
    if diagnostic:
        digests["subtitleDiagnostic"] = diagnostic
    timing_audio = validate_rendered_timing_repair(metadata)
    if timing_audio:
        digests['timingAudio'] = timing_audio
    timeline = metadata.get('editorialTimeline')
    if timeline != review.get('editorialTimeline') or metadata.get('style') == 'highlight_first' and not timeline:
        raise ValueError('editorial timeline changed after final review')
    if timeline:
        files = [timeline['baseline']['metadata'], timeline['baseline']['media'], timeline['baseline']['subtitles'],
                 timeline['opManifest'], timeline['opMedia'], timeline['opSubtitles']]
        keys = ('metadata', 'media', 'subtitles', 'opManifest', 'opMedia', 'opSubtitles')
        hashes = [file_digest(file) for file in files]
        if any(timeline.get('binding', {}).get(key) != value for key, value in zip(keys, hashes)):
            raise ValueError('editorial composing source changed after review')
        digests['editorial'] = hashlib.sha256('\0'.join(hashes).encode()).hexdigest()
    if review.get("digests") != digests:
        raise ValueError("final publication artifacts changed after review")
    if review.get("source") != current_source:
        raise ValueError("final publication source changed after review")


def validate_policy(metadata, config):
    version = _policy_version(metadata)
    room = str(metadata.get("roomId") or "")
    settings = config.get("clipTopics" if version == TOPIC_POLICY_VERSION else "ownStreamClips") or {}
    policy = (settings.get("automaticPublication") or {}) if version == TOPIC_POLICY_VERSION else resolve_campaign_publication(settings, metadata, _timestamp)
    if (policy.get("mode") != "auto" or policy.get("policyVersion") != version
            or not str(policy.get("authorizationNote") or "").strip()):
        raise ValueError("automatic publication policy is disabled or does not authorize this room")
    if version == TOPIC_POLICY_VERSION:
        keywords = settings.get("keywords")
        ignored = settings.get("ignoredRoomIds", [])
        if (settings.get("enabled") is not True or policy.get("scope") != "configured_keywords"
                or not room.strip() or not isinstance(ignored, list) or room in [str(value) for value in ignored]
                or not isinstance(keywords, list) or not keywords
                or any(not isinstance(word, str) or not word.strip() for word in keywords)
                or not _topic_mentions(metadata, {word.strip() for word in keywords})):
            raise ValueError("automatic topic policy does not authorize this source room and configured keyword")
        policy = {**policy, "topicScope": {"scope": policy["scope"], "keywords": sorted({word.strip() for word in keywords}),
                                          "ignoredRoomIds": sorted({str(value) for value in ignored})}}
    elif room not in [str(value) for value in policy.get("roomIds", [])]:
        raise ValueError("automatic publication policy is disabled or does not authorize this room")
    if _timestamp(metadata.get("generatedAt")) < _timestamp(policy.get("activatedAt")):
        raise ValueError("artifact predates automatic publication activation; historical backlog requires explicit review")
    return policy


def make_authorization(metadata, clip_id, policy):
    version = _policy_version(metadata)
    authorization = {"version": 1, "authority": "configured_policy", "clipId": int(clip_id),
            "policyVersion": version, "activatedAt": policy["activatedAt"],
            "authorizationNote": policy["authorizationNote"], "roomId": str(metadata["roomId"]),
            "generatedAt": metadata["generatedAt"], "publicationIdentity": publication_identity(metadata),
            "reviewDigest": _digest_json(metadata["publicationReview"]),
            "decisionDigest": _digest_json(metadata["publicationDecision"]),
            "uploadDigest": _digest_json(metadata.get("upload") or {})}
    if version == TOPIC_POLICY_VERSION:
        authorization["topicScope"] = copy.deepcopy(policy["topicScope"])
    return authorization


def validate_saved_authorization(metadata, clip):
    authorization = clip.get("automaticPublicationAuthorization")
    if not authorization:
        raise ValueError("required automatic publication authorization was removed")
    expected = make_authorization(metadata, clip["id"], authorization)
    if authorization != expected or clip.get("publicationIdentity") != expected["publicationIdentity"]:
        raise ValueError("automatic publication authorization no longer matches this ID and reviewed artifact")
    if str(clip.get("roomId") or "") != str(metadata.get("roomId") or ""):
        raise ValueError("registry room differs from automatic publication authorization")
    for key in ("source", "prefix", "tags", "tid"):
        value = (metadata.get("upload") or {}).get(key)
        if value is not None and clip.get(key) != value:
            raise ValueError(f"registry {key} differs from automatic publication authorization")


def validate_job_authorizations(groups, job, load_config):
    snapshots = job.get("automaticPublicationAuthorizations") or {}
    errors = []
    config = None
    for group in groups:
        for clip in group:
            expected = snapshots.get(str(clip.get("id")))
            if not expected and not clip.get("automaticPublicationAuthorization") and not job.get("automaticPublication"):
                continue
            try:
                if (job.get("automaticPublication") is not True or job.get("allowDuplicateTitle")
                        or not expected or expected != clip.get("automaticPublicationAuthorization")
                        or clip.get("automaticPublicationRequired") is not True):
                    raise ValueError("automatic publication job authorization is missing or changed")
                metadata = json.loads(Path(clip["metadataPath"]).read_text(encoding="utf-8-sig"))
                validate_publication_review(metadata)
                validate_saved_authorization(metadata, clip)
                if config is None:
                    config = load_config()
                policy = validate_policy(metadata, config)
                if expected != make_authorization(metadata, clip["id"], policy):
                    raise ValueError("automatic publication policy authorization changed after enqueue")
            except (OSError, ValueError, TypeError, KeyError) as error:
                errors.append(f"clip ID{clip.get('id')}: {error}")
    return errors


def validate_submission_authorization(upload_clip, job_id, api):
    """Recheck the durable job at the final submit boundary, including later batch members."""
    queue = api.load_json(api.QUEUE_PATH, api.default_queue())
    job = api.find_queue_job(queue, job_id)
    if not job or job.get("status") != "running" or job.get("automaticPublication") is not True:
        raise ValueError("automatic publication authorization invalid: upload job is no longer running")
    registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
    matches = [registry.get("clips", {}).get(str(clip_id)) for clip_id in job.get("clipIds", [])]
    matches = [clip for clip in matches if clip and int(clip.get("reviewIndex") or 0) == int(upload_clip.get("idx") or 0)
               and api.paths_match(clip.get("metadataPath") or "", upload_clip.get("metadataPath") or "")]
    if len(matches) != 1:
        raise ValueError("automatic publication authorization invalid: ambiguous or missing upload ID")
    clip = {**matches[0], **{key: upload_clip.get(key) for key in
        ("title", "description", "mediaPath", "coverPath", "roomId", "prefix", "source", "tags", "tid")}}
    errors = api.validate_groups([[clip]]) + validate_job_authorizations([[clip]], job, api.load_upload_runtime_config)
    if errors:
        raise ValueError("automatic publication authorization invalid: " + "; ".join(errors))


def _record_identity(clip):
    if clip.get("publicationIdentity"):
        return clip["publicationIdentity"]
    try:
        metadata = json.loads(Path(clip.get("metadataPath") or "").read_text(encoding="utf-8-sig"))
        return optional_publication_identity(metadata)
    except (OSError, ValueError, TypeError):
        return ""


def enqueue_automatic(args, api):
    """Only explicitly supplied IDs; one uncertain clip never blocks its siblings."""
    ids = list(dict.fromkeys(api.parse_int_list(args.ids)))
    prior_metadata = getattr(args, "prior_metadata", None)
    if prior_metadata and len(ids) != 1:
        raise ValueError("explicit automatic reconciliation accepts one original ID")
    if not ids or getattr(args, "force", False) or getattr(args, "collection_section_id", None):
        print("[ERROR] automatic enqueue needs explicit IDs and cannot use force/collection overrides", file=sys.stderr)
        return 2
    batch_size = int(getattr(args, "batch_size", api.DEFAULT_BATCH_SIZE))
    timeout = int(getattr(args, "timeout_seconds", api.DEFAULT_BATCH_TIMEOUT_SECONDS))
    if batch_size < 1 or timeout < 60:
        print("[ERROR] invalid automatic enqueue batch size or timeout", file=sys.stderr)
        return 2
    results, selected, authorizations, reconciliations = [], [], {}, {}
    config = api.load_upload_runtime_config()
    # The transaction serializes both source identity deduplication and registry authorization writes.
    transaction = nullcontext(api.load_json(api.QUEUE_PATH, api.default_queue())) if args.dry_run else api.queue_transaction()
    with transaction as queue:
        registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
        api.sync_clip_statuses(registry, [i for i in ids if str(i) in registry.get("clips", {})])
        active = api.clip_candidate_queue.active_ids(queue)
        reserved = {}
        for existing in registry.get("clips", {}).values():
            if (int(existing["id"]) in active or existing.get("status") == "uploading"
                    or api.clip_candidate_queue.is_published(existing) or existing.get("editorialExclusion") or existing.get("uploadCancellation")):
                identity = _record_identity(existing)
                if identity:
                    reserved[identity] = existing
        for clip_id in ids:
            clip = registry.get("clips", {}).get(str(clip_id))
            result = {"id": clip_id}
            try:
                if not clip:
                    raise ValueError("unknown clip ID")
                if api.clip_candidate_queue.is_published(clip):
                    result["status"] = "already_uploaded"
                elif clip_id in active or clip.get("status") == "uploading":
                    result["status"] = "already_queued"
                else:
                    if clip.get("editorialExclusion") or clip.get("uploadCancellation") or clip.get("status") == "cancelled":
                        raise ValueError("clip is manually excluded or cancelled")
                    if clip.get("pendingCut") or clip.get("pendingRebuild") or clip.get("reviewPending") and not prior_metadata:
                        raise ValueError("clip needs review or rendering before automatic publication")
                    metadata = json.loads(Path(clip["metadataPath"]).read_text(encoding="utf-8-sig"))
                    validate_publication_review(metadata)
                    policy = validate_policy(metadata, config)
                    authorization = make_authorization(metadata, clip_id, policy)
                    candidate = clip
                    if prior_metadata:
                        try:
                            from .clip_automatic_retry import reconcile
                        except ImportError:
                            from clip_automatic_retry import reconcile
                        reconciliations[str(clip_id)] = reconcile(clip, metadata, prior_metadata, queue.get("jobs", []))
                        candidate = {**clip, "reviewPending": False, "reviewIssues": [], "publicationIdentity": authorization["publicationIdentity"],
                            "automaticPublicationAuthorization": authorization}
                    identity = authorization["publicationIdentity"]
                    duplicate = reserved.get(identity)
                    if duplicate and int(duplicate["id"]) != clip_id:
                        result.update(status="duplicate", duplicateOf=int(duplicate["id"]))
                    else:
                        errors = api.validate_groups([[candidate]])
                        if selected:
                            errors.extend(api.clip_upload_enqueue.publication_errors(api,
                                [registry['clips'][str(i)] for i in selected] + [candidate], registry))
                        if errors:
                            raise ValueError("; ".join(errors))
                        result["status"] = "would_queue" if args.dry_run else "queued"
                        selected.append(clip_id)
                        authorizations[str(clip_id)] = authorization
                        reserved[identity] = clip
            except (OSError, ValueError, TypeError, KeyError, RuntimeError) as error:
                result.update(status="needs_human", error=str(error))
            results.append(result)
        if selected and not args.dry_run:
            job_id = f"auto-upload-{int(time.time())}"
            used = {str(job.get("id")) for job in queue.get("jobs", [])}
            suffix = 2
            while job_id in used:
                job_id = f"auto-upload-{int(time.time())}-{suffix}"
                suffix += 1
            job = {"id": job_id, "createdAt": api.now_iso(), "updatedAt": api.now_iso(), "status": "pending",
                   "clipIds": selected, "candidateSubtitles": {}, "automaticPublication": True,
                   "automaticPublicationAuthorizations": copy.deepcopy(authorizations), "allowDuplicateTitle": False,
                   "delay": int(getattr(args, "delay", api.DEFAULT_DELAY)),
                   "rateLimitWait": int(getattr(args, "rate_limit_wait", api.DEFAULT_RATE_LIMIT_WAIT)),
                   "rateLimitRetries": int(getattr(args, "rate_limit_retries", api.DEFAULT_RATE_LIMIT_RETRIES)),
                   "batchSize": batch_size, "timeoutSeconds": timeout,
                   "note": str(getattr(args, "note", "") or "Configured automatic ordinary clip publication")}
            queue.setdefault("jobs", []).append(job)
            for clip_id in selected:
                clip = registry["clips"][str(clip_id)]
                authorization = authorizations[str(clip_id)]
                if str(clip_id) in reconciliations:
                    clip.setdefault("automaticPublicationAuthorizationHistory", []).append({
                        "authorization": copy.deepcopy(clip["automaticPublicationAuthorization"]), "reconciliation": reconciliations[str(clip_id)]})
                    clip.update(reviewPending=False, reviewIssues=[], automaticPublicationReconciliation=reconciliations[str(clip_id)])
                clip.update(status="queued", updatedAt=api.now_iso(), automaticPublicationRequired=True,
                            automaticPublicationAuthorization=authorization,
                            publicationIdentity=authorization["publicationIdentity"])
                clip.pop("failureReason", None)
            api.save_json(api.REGISTRY_PATH, registry)
    print("AUTOMATIC_ENQUEUE_RESULT:", json.dumps({"results": results, "queuedIds": selected if not args.dry_run else []}, ensure_ascii=False))
    return 0
