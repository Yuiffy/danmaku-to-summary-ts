"""Save a cover revision for an existing numeric ID, without approving or uploading."""
import json
import hashlib
import sys
import uuid
from pathlib import Path
try:
    from .cover_selection import validate_selection, media_identity, selected_cover
except ImportError:
    from cover_selection import validate_selection, media_identity, selected_cover


def editable(api, clip, queue):
    if (not clip or not clip.get("metadataPath") or clip.get("pendingCut") or clip.get("pendingRebuild")
            or clip.get("status") in ("uploaded", "uploading", "queued", "excluded", "cancelled")
            or int(clip["id"]) in api.clip_candidate_queue.active_ids(queue)):
        raise ValueError("Only a rendered, unqueued clip can change its cover")


def edit_cover(args, api, generator=None):
    output = None
    committed = False
    try:
        selection = validate_selection(json.loads(args.selection))
        if not args.note.strip() or len(args.note) > 1000:
            raise ValueError("A cover edit note is required")
        handle = api.acquire_queue_mutation_lock()
        try:
            registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
            clip = registry.get("clips", {}).get(str(args.id))
            editable(api, clip, api.load_json(api.QUEUE_PATH, api.default_queue()))
            clip_before = json.dumps(clip, sort_keys=True)
            metadata_path = Path(clip["metadataPath"])
            before = metadata_path.read_bytes()
            metadata = json.loads(before.decode("utf-8-sig"))
            if metadata.get("rebuildRequired"):
                raise ValueError("Render the pending video revision before selecting a cover")
            parts = (metadata.get("output") or {}).get("parts") or clip.get("parts") or []
            if selection["part"] > max(1, len(parts)):
                raise ValueError("Unknown video part")
            media = (parts[selection["part"] - 1].get("mediaPath") if parts else
                     clip.get("mediaPath") or (metadata.get("output") or {}).get("mediaPath"))
            identity = media_identity(media)
        finally:
            api.release_queue_mutation_lock(handle)
        output = metadata_path.parent / "cover_revisions" / f"{args.id}-{uuid.uuid4()}.jpg"
        output.parent.mkdir(parents=True, exist_ok=True)
        if generator is None:
            try:
                from .cover_generator import CoverGenerator
            except ImportError:
                from cover_generator import CoverGenerator
            generator = CoverGenerator()
        selected_cover(generator, media, selection, str(output))
        if not output.is_file() or not output.stat().st_size:
            raise ValueError("Cover rendering did not produce an image")
        handle = api.acquire_queue_mutation_lock()
        try:
            registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
            clip = registry.get("clips", {}).get(str(args.id))
            editable(api, clip, api.load_json(api.QUEUE_PATH, api.default_queue()))
            if (json.dumps(clip, sort_keys=True) != clip_before or metadata_path.read_bytes() != before
                    or media_identity(media) != identity):
                raise ValueError("Clip changed during cover rendering; refresh and retry")
            metadata["coverSelection"] = {**selection, "mediaIdentity": identity, "note": args.note, "at": api.now_iso()}
            metadata.setdefault("copy", {})["coverText"] = selection["text"]
            metadata.setdefault("output", {}).update(coverPath=str(output), coverError=None)
            if parts:
                metadata["coverSha256"] = hashlib.sha256(output.read_bytes()).hexdigest()
            metadata["uploadReady"] = False
            # Keep prior evidence for inspection, but revoke every old artifact approval.
            for key in ("ownStreamHumanReview", "publicationReview", "qaResult", "activityReview", "gameReview"):
                if isinstance(metadata.get(key), dict):
                    metadata[key] = {**metadata[key], "status": "needs_review"}
            clip.update(coverPath=str(output), reviewPending=True, status="needs_review", updatedAt=api.now_iso())
            clip["reviewIssues"] = list(dict.fromkeys([*(clip.get("reviewIssues") or []), "封面已修改，请重新核对成片与封面"]))
            api.save_json(metadata_path, metadata)
            committed = True  # Retain the new image even if the registry write fails after metadata commits.
            api.save_json(api.REGISTRY_PATH, registry)
        finally:
            api.release_queue_mutation_lock(handle)
        print(f"[OK] ID{args.id}: cover saved; review required; upload is NOT queued")
        return 0
    except (OSError, ValueError, RuntimeError, TypeError, KeyError, api.subprocess.SubprocessError) as error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 2
    finally:
        if output and not committed:
            output.unlink(missing_ok=True)


def register_commands(sub, api):
    parser = sub.add_parser("cover", help="Select a rendered video frame/crop and reletter the cover; never approves or uploads")
    parser.add_argument("--id", required=True, type=int)
    parser.add_argument("--selection", required=True, help="JSON: video-relative time, part, text, optional normalized crop")
    parser.add_argument("--note", required=True)
    parser.set_defaults(func=lambda args: edit_cover(args, api))
