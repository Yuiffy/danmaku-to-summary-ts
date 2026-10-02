"""Review and content binding for complete singing/viewing multipart submissions."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

TYPE = "stream_activity_submission"


def file_digest(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def content_digest(metadata):
    fields = ("kind", "sourceSnapshot", "transcript", "planSignature", "coverage", "activities", "window", "copy", "upload", "output", "coverSha256")
    payload = {key: metadata.get(key) for key in fields}
    title_evidence = (metadata.get("presentation") or {}).get("titleEvidence")
    if title_evidence:
        payload["titleEvidence"] = title_evidence
    return hashlib.sha256(json.dumps(payload, sort_keys=True,
        ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def check_artifacts(metadata):
    if metadata.get("type") != TYPE or metadata.get("version") != 1 or metadata.get("kind") not in ("songs", "watch"):
        raise ValueError("invalid stream activity submission")
    coverage = metadata.get("coverage") or {}
    if coverage.get("status") != "complete" or not coverage.get("windows"):
        raise ValueError("activity detection coverage is incomplete")
    end = 0
    for window in coverage["windows"]:
        if window.get("status") != "inspected" or abs(window["start"] - end) > .01 or window["end"] <= end:
            raise ValueError("activity detection has an uninspected gap")
        end = window["end"]
    if abs(end - coverage["duration"]) > .01:
        raise ValueError("activity detection does not cover the complete recording")
    upload = metadata.get("upload") or {}
    if not isinstance(upload.get("collectionSectionId"), int) or upload["collectionSectionId"] <= 0:
        raise ValueError("dedicated activity collection section is missing")
    parts = (metadata.get("output") or {}).get("parts")
    if not isinstance(parts, list) or not 1 <= len(parts) <= 100:
        raise ValueError("multipart submission must have 1–100 Ps")
    activities = {row["id"]: row for row in metadata.get("activities") or []}
    if not activities:
        raise ValueError("activity submission has no source activities")
    title_evidence = (metadata.get("presentation") or {}).get("titleEvidence")
    if title_evidence and (title_evidence.get("method") != "source_frame_reading"
            or title_evidence.get("activityId") not in activities
            or not str(title_evidence.get("name") or "").strip()
            or not str(title_evidence.get("note") or "").strip()
            or file_digest(title_evidence["framePath"]) != title_evidence.get("frameSha256")):
        raise ValueError("activity public title evidence changed or is invalid")
    by_activity = {}
    previous = -1
    for part in parts:
        start, end = part.get("start"), part.get("end")
        if any(isinstance(n, bool) or not isinstance(n, (float, int)) or not math.isfinite(n) for n in (start, end)) or start < previous or end <= start:
            raise ValueError("multipart intervals are invalid or out of order")
        if abs(end - start - part["duration"]) > .01 or abs(part["actualDuration"] - part["duration"]) > .25:
            raise ValueError("multipart rendered duration differs from its source interval")
        previous = end
        if not str(part.get("title") or "").strip() or len(part["title"]) > 80:
            raise ValueError("invalid P title")
        if part.get("activityId") not in activities:
            raise ValueError("P has an unknown source activity")
        by_activity.setdefault(part["activityId"], []).append(part)
        video = Path(part["mediaPath"])
        if video.stat().st_size != part["bytes"] or file_digest(video) != part["sha256"]:
            raise ValueError("activity P changed after rendering")
        if metadata["kind"] == "watch" and part["duration"] > 1800 + .01:
            raise ValueError("viewing P exceeds 30 minutes")
    for activity_id, event in activities.items():
        selected = by_activity.get(activity_id) or []
        if not selected:
            raise ValueError("a source activity is missing from this submission")
        if metadata["kind"] == "songs":
            if event.get("kind") != "song" or len(selected) != 1 or selected[0]["start"] > event["start"] or selected[0]["end"] < event["end"]:
                raise ValueError("one complete performance must occupy exactly one P")
        else:
            if event.get("kind") != "watch" or abs(selected[0]["start"] - event["start"]) > .01 or abs(selected[-1]["end"] - event["end"]) > .01:
                raise ValueError("viewing session is not completely covered")
            if any(abs(a["end"] - b["start"]) > .01 for a, b in zip(selected, selected[1:])):
                raise ValueError("viewing Ps have a gap or duplicated interval")
    output = metadata["output"]
    transcript = metadata.get("transcript")
    if transcript and file_digest(transcript["path"]) != transcript.get("sha256"):
        raise ValueError("activity detection transcript changed")
    if Path(output["mediaPath"]).resolve() != Path(parts[0]["mediaPath"]).resolve():
        raise ValueError("multipart primary video differs from P1")
    if file_digest(output["coverPath"]) != metadata.get("coverSha256"):
        raise ValueError("activity cover changed after rendering")


def validate_activity_review(metadata):
    review = metadata.get("activityReview") or {}
    if (metadata.get("uploadReady") is not True or review.get("version") != 1 or review.get("status") != "approved"
        or review.get("authority") != "human" or not str(review.get("note") or "").strip()):
        raise ValueError("complete song/viewing boundaries and public copy need review")
    if review.get("contentSha256") != content_digest(metadata):
        raise ValueError("activity submission changed after review")
    check_artifacts(metadata)


def approve(path, note):
    path = Path(path).resolve()
    if not note.strip():
        raise ValueError("activity review needs a substantive note")
    metadata = json.loads(path.read_text(encoding="utf-8-sig"))
    check_artifacts(metadata)
    source = metadata["sourceSnapshot"]
    stat = Path(source["mediaPath"]).stat()
    if str(stat.st_size) != source["mediaBytes"] or str(stat.st_mtime_ns) != source["mediaMtimeNs"]:
        raise ValueError("activity recording changed before review")
    for key in ("srt", "xml"):
        if source.get(key + "Path") and file_digest(source[key + "Path"]) != source[key + "Sha256"]:
            raise ValueError("activity source evidence changed before review")
    metadata["activityReview"] = {"version": 1, "status": "approved", "authority": "human", "note": note,
        "contentSha256": content_digest(metadata)}
    metadata["uploadReady"] = True
    validate_activity_review(metadata)
    temporary = path.with_suffix(path.suffix + ".review.tmp")
    temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--note", required=True)
    args = parser.parse_args()
    try:
        approved = approve(args.metadata, args.note)
        print(f"[OK] reviewed multipart submission: {approved}")
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(2, f"[ERROR] {error}\n")


if __name__ == "__main__":
    main()
