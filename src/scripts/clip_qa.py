"""Content-bound quality gates; this module never grants upload authorization."""
import hashlib
import json
from pathlib import Path


def _file_digest(value):
    digest = hashlib.sha256()
    with Path(value).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_metadata_qa(metadata):
    if metadata.get("publicCopyPending"):
        raise ValueError("clip public copy is pending; generate and review publishing copy before upload")
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
        return
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


def validate_registry_qa(groups):
    errors = []
    for group in groups:
        for clip in group:
            metadata_path = clip.get("metadataPath")
            if not metadata_path:
                if clip.get("qaRequired"):
                    errors.append("reviewed clip is missing metadataPath")
                continue
            if not Path(metadata_path).exists() and not clip.get("qaRequired"):
                continue
            try:
                metadata = json.loads(Path(metadata_path).read_text(encoding="utf-8-sig"))
                if clip.get("qaRequired") and not metadata.get("qaRequired"):
                    raise ValueError("required AI quality review was removed")
                validate_metadata_qa(metadata)
                if metadata.get("qaRequired"):
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
