"""Explicit human enqueue path; dependencies remain injectable through the registry API."""

import argparse
import subprocess
import sys
import time
from pathlib import Path
try:
    from .clip_publication_duplicates import duplicate_errors
    from .clip_quality_policy import quality_errors
except ImportError:
    from clip_publication_duplicates import duplicate_errors
    from clip_quality_policy import quality_errors


def publication_errors(api, clips, registry=None, *, manual_enqueue=False):
    registry = registry if registry is not None else api.load_json(api.REGISTRY_PATH, api.default_registry())
    def read_metadata(value):
        try:
            return api.load_json(Path(value), {})
        except (OSError, ValueError):
            return {}
    # Explicit numeric enqueue may first render an approved candidate revision.
    # The worker checks every finished artifact after rendering and before upload.
    quality_clips = [clip for clip in clips if not (manual_enqueue and
                     (clip.get('pendingCut') or clip.get('pendingRebuild')))]
    return (title_errors(clips)
            + duplicate_errors(clips, registry.get('clips', {}).values(), read_metadata)
            + quality_policy_errors(api, quality_clips))


def title_errors(clips):
    """Reject deterministic Bilibili title failures before creating a queue job.

    Registry records keep the display prefix separately from the title body, but
    Bilibili validates the concatenated title. The 80-character limit therefore
    applies to both fields together.
    """
    errors = []
    for clip in clips:
        # Some quality-policy callers use partial clip records without a title;
        # leave completeness validation to their existing policy in that case.
        if clip.get('title') is None:
            continue
        title = f"{clip.get('prefix') or ''}{clip.get('title') or ''}".strip()
        if not title or len(title) > 80:
            errors.append(f"clip {clip.get('id')}: title must be 1-80 characters including prefix")
    return errors


def quality_policy_errors(api, clips):
    if not clips:
        return []
    from hashlib import file_digest
    try:
        from .clip_qa import validate_human_review, validate_metadata_qa
    except ImportError:
        from clip_qa import validate_human_review, validate_metadata_qa
    def read_metadata(value):
        return api.load_json(Path(value), {})
    def digest(value):
        with Path(value).open('rb') as handle:
            return file_digest(handle, 'sha256').hexdigest()
    def manual_review(clip, metadata):
        if metadata.get('bundlePublicationReview'):
            validate_metadata_qa(metadata)
            return
        review = metadata.get('ownStreamHumanReview')
        if review:
            if clip.get('id') is not None and review.get('clipId') != clip['id']:
                raise ValueError('human editorial choice belongs to a different clip ID')
            validate_human_review(metadata)
            return
        review, revision = metadata['precisionPublicationReview'], metadata.get('precisionRevision') or {}
        if (review.get('authority') != 'user' or not str(review.get('note') or '').strip()
                or not review.get('qaDigests') or review['qaDigests'] != (metadata.get('qaResult') or {}).get('digests')
                or revision.get('uploadAuthorized') is not True
                or clip.get('id') is not None and revision.get('clipId') != clip['id']):
            raise ValueError('human editorial choice belongs to a different clip ID')
        validate_metadata_qa(metadata)
        snapshot, source = revision.get('sourceSnapshot') or {}, metadata.get('source') or {}
        stat = Path(source['mediaPath']).stat()
        actual = {'mediaPath': str(Path(source['mediaPath']).resolve()), 'mediaBytes': str(stat.st_size),
                  'mediaMtimeNs': str(stat.st_mtime_ns), 'srtPath': str(Path(source['srtPath']).resolve()),
                  'srtSha256': digest(source['srtPath']),
                  'xmlPath': str(Path(source['xmlPath']).resolve()) if source.get('xmlPath') else None,
                  'xmlSha256': digest(source['xmlPath']) if source.get('xmlPath') else None}
        if actual != snapshot:
            raise ValueError('source changed after human precision selection')
    return quality_errors(clips, api.load_upload_runtime_config(), read_metadata, digest, manual_review)


def validate_saved_titles(api, registry, ids):
    """A CLI recovery must not discard an operator's unresolved Web title choice.

    Read only the latest explicitly selected/reset set; merely opening a new
    evidence revision does not withdraw an earlier human choice. Never apply an
    old choice to changed evidence here: the review workflow must resolve it.
    """
    for clip_id in ids:
        file = Path(api.REGISTRY_PATH).parent / 'admin' / 'title-choices' / f'{clip_id}.json'
        data = api.load_json(file, {'sets': []})
        selected_sets = [item for item in data.get('sets', []) if item.get('history')]
        if not selected_sets:
            continue
        latest = max(selected_sets, key=lambda item: item['history'][-1]['at'])
        selection = latest.get('selection')
        if selection is None:
            continue
        title = selection.get('title')
        if not isinstance(title, str) or not title.strip():
            raise ValueError(f'ID{clip_id}: invalid saved Web title; refresh the title selection')
        clip = registry['clips'][str(clip_id)]
        metadata = api.load_json(Path(clip['metadataPath']), {}) if clip.get('metadataPath') else {}
        prefix = clip.get('prefix') or ''

        def normalized(value):
            value = str(value or '').strip()
            return value[len(prefix):] if prefix and value.startswith(prefix) else value

        if any(normalized(value) != normalized(title) for value in
               (clip.get('title'), (metadata.get('copy') or {}).get('title'))):
            raise ValueError(f'ID{clip_id}: saved Web title has not been applied; use feedback-publish '
                             'to apply/review the selected title, or explicitly reset the title selection')


def saved_title_errors(api, clips):
    # Manifest preflight also validates rows before numeric registry IDs exist.
    clips = [clip for clip in clips if clip.get('id') is not None]
    try:
        validate_saved_titles(api, {'clips': {str(clip['id']): clip for clip in clips}},
                              [clip['id'] for clip in clips])
    except (OSError, ValueError, KeyError, TypeError) as error:
        return [str(error)]
    return []


def enqueue(args: argparse.Namespace, api) -> int:
    ids = api.parse_int_list(args.ids)
    if not ids:
        print("[ERROR] --ids is empty", file=sys.stderr)
        return 2
    batch_size = int(getattr(args, "batch_size", api.DEFAULT_BATCH_SIZE))
    timeout_seconds = int(
        getattr(args, "timeout_seconds", api.DEFAULT_BATCH_TIMEOUT_SECONDS)
    )
    if batch_size < 1:
        print("[ERROR] --batch-size must be at least 1", file=sys.stderr)
        return 2
    if timeout_seconds < 60:
        print("[ERROR] --timeout-seconds must be at least 60", file=sys.stderr)
        return 2
    registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
    missing = [clip_id for clip_id in ids if str(clip_id) not in registry.get("clips", {})]
    if missing:
        print(f"[ERROR] unknown clip ids: {missing}", file=sys.stderr)
        return 2
    try:
        validate_saved_titles(api, registry, ids)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 2
    held = [clip_id for clip_id in ids if registry["clips"][str(clip_id)].get("editorialExclusion") or (
            registry["clips"][str(clip_id)].get("reviewPending")
            and not registry["clips"][str(clip_id)].get("pendingRebuild"))]
    if held:
        print(f"[ERROR] IDs excluded or need review before upload (force cannot bypass): {held}. Use show/subtitles to inspect their reviewIssues.", file=sys.stderr)
        return 2
    api.sync_clip_statuses(registry, ids)
    already_uploaded = [clip_id for clip_id in ids if registry["clips"][str(clip_id)].get("status") == "uploaded"]
    revised_published = [clip_id for clip_id in ids if registry["clips"][str(clip_id)].get("subtitleRevisionKind") == "own_stream"
                         and api.clip_candidate_queue.is_published(registry["clips"][str(clip_id)])]
    if revised_published:
        print(f"[ERROR] revised published IDs require replacing their original submissions, not duplicate uploads: {revised_published}", file=sys.stderr)
        return 2
    if already_uploaded and not args.force:
        print(f"[ERROR] already uploaded ids (use --force to enqueue anyway): {already_uploaded}", file=sys.stderr)
        return 2
    collection_section_id = getattr(args, "collection_section_id", None)
    if collection_section_id is not None and (collection_section_id <= 0 or len(ids) != 1
            or not registry["clips"][str(ids[0])].get("manifestPath")):
        print("[ERROR] --collection-section-id requires one JSON-backed clip and a positive ID", file=sys.stderr)
        return 2
    if args.dry_run:
        errors = publication_errors(api, [registry['clips'][str(i)] for i in ids], registry, manual_enqueue=True)
        if errors:
            print('[ERROR] ' + '; '.join(errors), file=sys.stderr)
            return 2
        for clip_id in ids:
            clip = registry["clips"][str(clip_id)]
            action = "cut_then_upload" if clip.get("pendingCut") or clip.get("pendingRebuild") else "upload"
            print(f"{clip_id}: [{action}] #{clip.get('reviewIndex')} {clip.get('prefix', '')}{clip.get('title', '')}")
        return 0

    with api.queue_transaction() as queue:
        # Re-read the registry under the same short lock used by every queue
        # writer. This also serializes two enqueue commands updating statuses.
        registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
        missing = [
            clip_id
            for clip_id in ids
            if str(clip_id) not in registry.get("clips", {})
        ]
        if missing:
            print(f"[ERROR] unknown clip ids: {missing}", file=sys.stderr)
            return 2
        held = [clip_id for clip_id in ids if registry["clips"][str(clip_id)].get("editorialExclusion") or (
                registry["clips"][str(clip_id)].get("reviewPending")
                and not registry["clips"][str(clip_id)].get("pendingRebuild"))]
        if held:
            print(f"[ERROR] IDs excluded or need review before upload (force cannot bypass): {held}", file=sys.stderr)
            return 2
        api.sync_clip_statuses(registry, ids)
        revised_published = [clip_id for clip_id in ids if registry["clips"][str(clip_id)].get("subtitleRevisionKind") == "own_stream"
                             and api.clip_candidate_queue.is_published(registry["clips"][str(clip_id)])]
        if revised_published:
            print(f"[ERROR] revised published IDs cannot be re-enqueued: {revised_published}", file=sys.stderr)
            return 2
        already_uploaded = [
            clip_id
            for clip_id in ids
            if registry["clips"][str(clip_id)].get("status") == "uploaded"
        ]
        if already_uploaded and not args.force:
            print(
                "[ERROR] already uploaded ids (use --force to enqueue anyway): "
                f"{already_uploaded}",
                file=sys.stderr,
            )
            return 2

        active = api.clip_candidate_queue.active_ids(queue)
        ids = [clip_id for clip_id in ids if clip_id not in active]
        if not ids:
            print("[OK] requested IDs are already queued; no duplicate job created")
            return 0
        try:
            errors = publication_errors(api, [registry['clips'][str(i)] for i in ids], registry, manual_enqueue=True)
            if errors:
                raise ValueError('; '.join(errors))
            validate_saved_titles(api, registry, ids)
            snapshots = api.clip_candidate_queue.approve_for_queue(api, registry, ids, args.note,
                getattr(args, "expected_candidate_drafts", None))
            validate_saved_titles(api, registry, ids)
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            print(f"[ERROR] {error}", file=sys.stderr)
            return 2

        base_job_id = f"upload-{int(time.time())}"
        existing_job_ids = {
            str(existing.get("id") or "") for existing in queue.get("jobs", [])
        }
        job_id = base_job_id
        suffix = 2
        while job_id in existing_job_ids:
            job_id = f"{base_job_id}-{suffix}"
            suffix += 1
        job = {
            "id": job_id,
            "createdAt": api.now_iso(),
            "updatedAt": api.now_iso(),
            "status": "pending",
            "clipIds": ids,
            "candidateSubtitles": snapshots,
            "delay": int(args.delay),
            "rateLimitWait": int(args.rate_limit_wait),
            "rateLimitRetries": int(args.rate_limit_retries),
            "batchSize": batch_size,
            "timeoutSeconds": timeout_seconds,
            "note": args.note or "",
            "collectionSectionId": collection_section_id,
            # ``--force`` explicitly authorizes re-submission, including when
            # Bilibili already has the same title.
            "allowDuplicateTitle": bool(args.force),
        }
        queue.setdefault("jobs", []).append(job)
        for clip_id in ids:
            clip = registry["clips"][str(clip_id)]
            if clip.get("status") != "uploaded" or args.force:
                clip["status"] = "queued"
                clip.pop("uploadCancellation", None)
                clip.pop("automaticPublicationAuthorization", None)
                clip.pop("failureReason", None)
                clip["updatedAt"] = api.now_iso()
        api.save_json(api.REGISTRY_PATH, registry)
    print(f"[OK] queued {len(ids)} clips as {job['id']}: {','.join(str(i) for i in ids)}")
    print(f"QUEUE_JOB_ID: {job['id']}")
    return 0
