"""Publish a user-reviewed precision revision as an edit of its existing BV."""
import asyncio
import copy
import json
import subprocess
from pathlib import Path


def precision_public_copy(metadata, public_copy=None):
    script = Path(__file__).parent / 'clipping' / 'precision_copy.js'
    result = subprocess.run(['node', str(script)],
        input=json.dumps({'metadata': metadata, 'copy': public_copy}, ensure_ascii=False),
        text=True, encoding='utf-8', capture_output=True, timeout=30, check=False,
        **({'creationflags': subprocess.CREATE_NO_WINDOW} if hasattr(subprocess, 'CREATE_NO_WINDOW') else {}))
    if result.returncode != 0:
        raise ValueError(f'Cannot generate precision disclosure: {result.stderr.strip()}')
    return json.loads(result.stdout)


def render_precision(args, api):
    script = Path(__file__).parent / 'clipping' / 'precision_revision.js'
    command = ['node', str(script), '--id', str(args.id), '--registry', str(api.REGISTRY_PATH), '--note', args.note]
    for field in ('style', 'avatar_mode', 'inset_plan', 'resume_from', 'sound_level_overrides', 'cover_text_position'):
        if getattr(args, field, None):
            command.extend(['--' + field.replace('_', '-'), getattr(args, field)])
    if args.allow_cover_face_overlap:
        command.append('--allow-cover-face-overlap')
    return api.subprocess.run(command, cwd=str(api.PROJECT_ROOT), check=False).returncode


def register_commands(sub, api):
    p = sub.add_parser('precision', help='Render a separate creative revision by ID; preserves original and uploaded clips')
    p.add_argument('--id', required=True, type=int)
    p.add_argument('--note', default='')
    p.add_argument('--style', choices=('accent', 'compact'), default=None)
    p.add_argument('--avatar-mode', choices=('auto', 'circle', 'closeup'), default=None)
    p.add_argument('--inset-plan', default=None, help='Source-bound editorial layout; final media QA still runs')
    p.add_argument('--resume-from', default=None, help='Reuse matching drafts; validate, render and review again')
    p.add_argument('--sound-level-overrides', default=None, help='Source-bound sound levels for a matching local revision')
    p.add_argument('--cover-text-position', choices=('center', 'bottom'), default=None)
    p.add_argument('--allow-cover-face-overlap', action='store_true', help='User-approved cover-only face/text overlap; other QA remains active')
    p.set_defaults(func=lambda args: render_precision(args, api))
    p = sub.add_parser('replace-precision', help='Replace an uploaded BV with a user-reviewed precision revision')
    p.add_argument('--id', required=True, type=int)
    p.add_argument('--revision', required=True)
    p.add_argument('--review-note', required=True)
    p.add_argument('--dry-run', action='store_true')
    p.set_defaults(func=lambda args: publish_precision(args, api))
    p = sub.add_parser('select-precision', help='Select a reviewed local precision revision for the existing unpublished ID')
    p.add_argument('--id', required=True, type=int)
    p.add_argument('--revision', required=True)
    p.add_argument('--review-note', required=True)
    p.set_defaults(func=lambda args: select_precision(args, api))


def select_precision(args, api):
    """Bind an unpublished ID to a checked revision; enqueue remains a separate command."""
    if not str(args.review_note).strip():
        raise ValueError('A publication review note is required')
    handle = api.acquire_queue_mutation_lock()
    try:
        registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
        record = registry.get('clips', {}).get(str(args.id))
        if not record:
            raise ValueError('Unknown numeric clip ID')
        api.sync_clip_statuses(registry, [args.id])
        queue = api.load_json(api.QUEUE_PATH, api.default_queue())
        if (api.clip_candidate_queue.is_published(record) or args.id in api.clip_candidate_queue.active_ids(queue)
                or record.get('editorialExclusion') or record.get('pendingRebuild')):
            raise ValueError('Published, queued, excluded or pending-rebuild clips cannot select another media revision')
        previous = record.get('precisionSelection') or {}
        original_path = previous.get('originalMetadataPath') or record['metadataPath']
        metadata, directory = validate_revision({**record, 'metadataPath': original_path}, args.revision)
        approved = copy.deepcopy(metadata)
        approved['uploadReady'] = True
        approved.pop('ownStreamHumanReview', None)
        approved['precisionRevision']['uploadAuthorized'] = True
        approved['precisionPublicationReview'] = {'authority': 'user', 'note': args.review_note,
            'approvedAt': api.now_iso(), 'qaDigests': approved['qaResult']['digests']}
        publication_path = directory / 'publication.json'
        approved['output']['metadataPath'] = str(publication_path)
        api.save_json(publication_path, approved)
        entry = api.load_upload_manifest(publication_path)[0]
        if int(entry.get('reviewIndex') or entry.get('idx') or 0) != int(record['reviewIndex']):
            raise ValueError('Precision review index does not match the existing ID')
        for key in ('title', 'description', 'start', 'duration', 'mediaPath', 'coverPath', 'srtPath',
                    'qaRequired', 'attributionRequired', 'humanReviewRequired', 'reviewPending', 'reviewIssues',
                    'publicCopyPending', 'attributionStatus', 'pendingCut', 'pendingRebuild'):
            if key in entry:
                record[key] = entry[key]
        record.update(metadataPath=str(publication_path), manifestPath=str(publication_path), status='review', updatedAt=api.now_iso(),
            precisionSelection={'originalMetadataPath': original_path, 'revisionPath': str(directory),
                'metadataPath': str(publication_path), 'qaDigests': approved['qaResult']['digests']})
        api.save_json(api.REGISTRY_PATH, registry)
        print(f'[OK] {args.id}: reviewed precision selected; upload is NOT queued')
        return 0
    finally:
        api.release_queue_mutation_lock(handle)


def validate_revision(record, revision_path):
    try:
        from .clip_qa import validate_metadata_qa, _file_digest
    except ImportError:
        from clip_qa import validate_metadata_qa, _file_digest
    directory = Path(revision_path).resolve()
    metadata_path = directory / 'clip.json'
    metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
    revision = metadata.get('precisionRevision') or {}
    if (revision.get('clipId') != record['id'] or revision.get('status') != 'pending_review'
            or Path(revision.get('originalMetadataPath', '')).resolve() != Path(record['metadataPath']).resolve()
            or (directory / 'original.json').read_bytes() != Path(record['metadataPath']).read_bytes()):
        raise ValueError('Precision revision does not match the registered ID and original metadata')
    if metadata.get('creativeResult', {}).get('status') != 'edited' or metadata.get('qaResult', {}).get('status') != 'passed':
        raise ValueError('Precision revision has no passed rendered-media review')
    if metadata.get('audioQa') and metadata['audioQa'].get('status') != 'passed':
        raise ValueError('Precision audio review did not pass')
    output = metadata.get('output') or {}
    for key in ('mediaPath', 'srtPath', 'coverPath'):
        if not Path(output.get(key, '')).resolve().is_relative_to(directory):
            raise ValueError('Revision artifacts must belong to the selected revision directory')
    snapshot = revision.get('sourceSnapshot') or {}
    source = metadata['source']
    stat = Path(source['mediaPath']).stat()
    if (str(stat.st_size) != snapshot.get('mediaBytes') or str(stat.st_mtime_ns) != snapshot.get('mediaMtimeNs')
            or _file_digest(source['srtPath']) != snapshot.get('srtSha256')
            or (source.get('xmlPath') and _file_digest(source['xmlPath']) != snapshot.get('xmlSha256'))):
        raise ValueError('Recording or source subtitles changed since rendering')
    # Explicit publication command supplies approval; it does not overwrite or bypass the saved QA hashes.
    checked = copy.deepcopy(metadata)
    checked['uploadReady'] = True
    checked.pop('ownStreamHumanReview', None)
    validate_metadata_qa(checked)
    return metadata, directory


def publish_precision(args, api):
    if not str(args.review_note).strip():
        raise ValueError('A user approval note is required')
    registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
    record = registry.get('clips', {}).get(str(args.id))
    if not record:
        raise ValueError('Unknown numeric clip ID')
    bvid = (record.get('uploadState') or {}).get('bvid')
    if record.get('status') != 'uploaded' or not bvid:
        raise ValueError('This edit command requires an existing uploaded BV; use the normal registry upload flow for a new submission')
    metadata, directory = validate_revision(record, args.revision)
    preview = precision_public_copy(metadata)
    approval = {'version': 1, 'clipId': args.id, 'bvid': bvid, 'authority': 'user',
                'note': args.review_note, 'approvedAt': api.now_iso(), 'qaDigests': metadata['qaResult']['digests'],
                'metadataPath': str(directory / 'clip.json')}
    if args.dry_run:
        print(json.dumps({'action': 'replace_existing_bv', **approval, 'precisionCopyPreview': preview,
                         'copyPolicy': 'Append precision label and rendered edit details to current online copy'}, ensure_ascii=False, indent=2))
        return 0
    approval_path = directory / 'PUBLICATION_APPROVAL.json'
    if approval_path.exists():
        previous = json.loads(approval_path.read_text(encoding='utf-8'))
        if previous['qaDigests'] != approval['qaDigests'] or previous['bvid'] != bvid:
            raise ValueError('Previous publication approval is for a different artifact')
    else:
        api.save_json(approval_path, approval)
    try:
        from .replace_video import replace_video
    except ImportError:
        from replace_video import replace_video
    result = asyncio.run(replace_video(bvid, metadata['output']['mediaPath'], cover_path=metadata['output']['coverPath'],
        receipt_path=directory / 'REPLACEMENT_RECEIPT.json', before_submit=lambda: validate_revision(record, directory),
        copy_transform=lambda current: precision_public_copy(metadata, current)))
    if result.get('status') != 'submitted' or result.get('bvid') != bvid:
        raise RuntimeError('No confirmed replacement submission was returned')
    # Preserve ordinary media as the re-rendering baseline and preserve the original upload's identity.
    latest = api.load_json(api.REGISTRY_PATH, api.default_registry())
    current = latest['clips'][str(args.id)]
    if current.get('uploadState', {}).get('bvid') != bvid:
        raise RuntimeError('Registry changed during edit; the external receipt is saved for reconciliation')
    current['precisionReplacement'] = {**result, 'revisionPath': str(directory), 'submittedAt': api.now_iso(),
                                       'approvalPath': str(approval_path), 'qaDigests': approval['qaDigests']}
    current['updatedAt'] = api.now_iso()
    api.save_json(api.REGISTRY_PATH, latest)
    print('PRECISION_PUBLISHED: ' + json.dumps(current['precisionReplacement'], ensure_ascii=False))
    return 0
