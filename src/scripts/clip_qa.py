"""Content-bound quality gates; this module never grants upload authorization."""
import hashlib
import json
import math
from pathlib import Path


def _file_digest(value):
    digest = hashlib.sha256()
    with Path(value).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_metadata_qa(metadata):
    duration_approval = metadata.get("durationApproval")
    bounds = metadata.get("window") or {}
    rejection = metadata.get("originalSelectionRejection") or {}
    if (duration_approval and (duration_approval.get("authority") != "user" or not str(duration_approval.get("note") or "").strip()
            or any(duration_approval.get(key) != bounds.get(key) for key in ("start", "end")))):
        raise ValueError("long-clip approval does not match the source window")
    if (rejection.get("reason") == "duration_out_of_bounds" and not metadata.get("selectionRejection")
            and bounds.get("end", 0) - bounds.get("start", 0) > rejection.get("maxClipSeconds", float("inf"))
            and not duration_approval):
        raise ValueError("a restored long clip requires explicit duration approval")
    draft = metadata.get("renderedSubtitles")
    if draft:
        if (metadata.get("rebuildRequired") or draft.get("renderedSha256") != draft.get("sha256")
                or draft.get("renderedRevision") != draft.get("revision")):
            raise ValueError("current subtitle revision needs rendering before upload")
        if (_file_digest(draft.get("path")) != draft.get("sha256")
                or _file_digest((metadata.get("output") or {}).get("srtPath")) != draft.get("sha256")):
            raise ValueError("rendered subtitles differ from the saved revision")
    if metadata.get("publicCopyPending"):
        raise ValueError("clip public copy is pending; generate and review publishing copy before upload")
    output = metadata.get("output") or {}
    if output.get("mediaError") or output.get("coverError"):
        raise ValueError(f"clip media/cover generation failed: {output.get('mediaError') or output.get('coverError')}")
    if metadata.get("ownStreamHumanReview"):
        validate_human_review(metadata)
        return
    if metadata.get("mode") == "own_stream_fun_review" and metadata.get("uploadReady") is False:
        raise ValueError("own-stream clip is not upload ready")
    candidate = metadata.get("candidate") or {}
    copy = metadata.get("copy") or {}
    # Old recall-only batches promoted the internal event directly into title.
    if (metadata.get("mode") == "own_stream_fun_review"
            and candidate.get("selectionSource") == "recall_pool_fallback"
            and str(candidate.get("event") or "").strip()
            and str(copy.get("title") or "").strip() == str(candidate["event"]).strip()
            and not candidate.get("description") and not candidate.get("coverText")):
        raise ValueError("clip title is an internal recall event; repair publishing copy before upload")
    if not metadata.get("qaRequired"):
        validate_attribution(metadata)
        return
    validate_attribution(metadata)
    qa = metadata.get("qaResult") or {}
    if qa.get("version") != 1 or qa.get("status") != "passed" or metadata.get("uploadReady") is not True:
        raise ValueError("clip AI quality review has not passed")
    output = metadata.get("output") or {}
    copy = metadata.get("copy") or {}
    hashes = {"video": _file_digest(output.get("mediaPath")), "cover": _file_digest(output.get("coverPath")),
              "subtitles": _file_digest(output.get("srtPath")),
              "copy": hashlib.sha256("\0".join(str(copy.get(key) or "") for key in
                                               ("title", "coverText", "description")).encode("utf-8")).hexdigest()}
    if hashes != qa.get("digests"):
        raise ValueError("clip artifacts changed after AI quality review")


def validate_attribution(metadata):
    if not metadata.get("attributionRequired"):
        return
    review = metadata.get("attributionReview") or {}
    if review.get("version") != 1 or review.get("status") != "passed" or metadata.get("uploadReady") is not True:
        raise ValueError("clip actor attribution review has not passed")
    copy = metadata.get("copy") or {}
    digest = hashlib.sha256("\0".join(str(copy.get(key) or "") for key in
        ("title", "coverText", "description")).encode("utf-8")).hexdigest()
    if digest != review.get("artifactCopyDigest"):
        raise ValueError("clip public copy changed after actor attribution review")
    window = metadata.get("window") or {}
    bounds = {key: window.get(key) for key in ("start", "end")}
    if (any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) for value in bounds.values())
            or bounds["end"] <= bounds["start"] or bounds != review.get("artifactWindow")):
        raise ValueError("clip source window changed after actor attribution review")
    output = metadata.get("output") or {}
    artifacts = {"video": _file_digest(output.get("mediaPath")), "subtitles": _file_digest(output.get("srtPath"))}
    if artifacts != review.get("artifactDigests"):
        raise ValueError("clip video or subtitles changed after actor attribution review")


def validate_human_review(metadata):
    review = metadata.get("ownStreamHumanReview") or {}
    if (metadata.get("mode") not in ("own_stream_fun_review", "local_review", "topic_candidate_manual_cut") or metadata.get("selectionRejection")
            or metadata.get("uploadReady") is not True or review.get("version") != 1
            or review.get("status") != "approved" or review.get("authority") != "human"
            or not str(review.get("note") or "").strip()):
        raise ValueError("explicit, complete human review is required")
    window = metadata.get("window") or {}
    bounds = {key: window.get(key) for key in ("start", "end")}
    if (any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) for value in bounds.values())
            or bounds["start"] < 0 or bounds["end"] <= bounds["start"] or bounds != review.get("artifactWindow")):
        raise ValueError("clip window changed after human review")
    output = metadata.get("output") or {}
    copy = metadata.get("copy") or {}
    hashes = {"video": _file_digest(output.get("mediaPath")), "subtitles": _file_digest(output.get("srtPath")),
              "cover": _file_digest(output.get("coverPath")), "copy": hashlib.sha256("\0".join(
                  str(copy.get(key) or "") for key in ("title", "coverText", "description")).encode("utf-8")).hexdigest()}
    if not output.get("burnedSubtitles") or hashes != review.get("digests"):
        raise ValueError("clip artifacts changed after human review")
    source = metadata.get("source") or {}
    recorded = review.get("source") or {}
    media = Path(source.get("mediaPath") or "").resolve()
    stat = media.stat()
    actual = {"mediaPath": str(media), "mediaBytes": str(stat.st_size), "mediaMtimeNs": str(stat.st_mtime_ns),
              "srtPath": str(Path(source.get("srtPath") or "").resolve()), "srtSha256": _file_digest(source.get("srtPath")),
              "xmlPath": str(Path(source["xmlPath"]).resolve()) if source.get("xmlPath") else None,
              "xmlSha256": _file_digest(source["xmlPath"]) if source.get("xmlPath") else None}
    if actual != recorded:
        raise ValueError("source changed after human review")


def validate_registry_qa(groups):
    errors = []
    for group in groups:
        for clip in group:
            if clip.get("reviewPending"):
                errors.append(f"clip ID{clip.get('id', '?')} needs review: {'; '.join(clip.get('reviewIssues') or [])}")
                continue
            metadata_path = clip.get("metadataPath")
            if not metadata_path:
                if clip.get("qaRequired") or clip.get("attributionRequired") or clip.get("humanReviewRequired"):
                    errors.append("reviewed clip is missing metadataPath")
                continue
            if not Path(metadata_path).exists() and not (clip.get("qaRequired") or clip.get("attributionRequired") or clip.get("humanReviewRequired")):
                continue
            try:
                metadata = json.loads(Path(metadata_path).read_text(encoding="utf-8-sig"))
                if clip.get("qaRequired") and not metadata.get("qaRequired"):
                    raise ValueError("required AI quality review was removed")
                if clip.get("attributionRequired") and not metadata.get("attributionRequired"):
                    raise ValueError("required actor attribution review was removed")
                if clip.get("humanReviewRequired") and not metadata.get("ownStreamHumanReview"):
                    raise ValueError("required human review was removed")
                if clip.get("humanReviewRequired") and metadata["ownStreamHumanReview"].get("clipId") != clip.get("id"):
                    raise ValueError("human review belongs to a different clip ID")
                validate_metadata_qa(metadata)
                if metadata.get("qaRequired") or metadata.get("attributionRequired") or metadata.get("ownStreamHumanReview"):
                    expected = {"title": metadata["copy"]["title"], "description": metadata["copy"]["description"],
                                "mediaPath": metadata["output"]["mediaPath"], "coverPath": metadata["output"]["coverPath"]}
                    for key, value in expected.items():
                        actual = clip.get(key)
                        same = Path(actual).resolve() == Path(value).resolve() if key.endswith("Path") and actual else actual == value
                        if not same:
                            raise ValueError(f"registry {key} differs from reviewed artifact")
            except (OSError, ValueError, TypeError, KeyError) as error:
                errors.append(f"clip quality gate {metadata_path}: {error}")
    return errors
