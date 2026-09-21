"""Publish a user-reviewed precision revision as an edit of its existing BV."""
import asyncio
import copy
import json
from pathlib import Path


def render_precision(args, api):
    script = Path(__file__).parent / 'clipping' / 'precision_revision.js'
    command = ['node', str(script), '--id', str(args.id), '--registry', str(api.REGISTRY_PATH), '--note', args.note]
    for field in ('style', 'avatar_mode', 'inset_plan', 'resume_from'):
        if getattr(args, field, None):
            command.extend(['--' + field.replace('_', '-'), getattr(args, field)])
    return api.subprocess.run(command, cwd=str(api.PROJECT_ROOT), check=False).returncode


def register_commands(sub, api):
    p = sub.add_parser('precision', help='Render a separate creative revision by ID; preserves original and uploaded clips')
    p.add_argument('--id', required=True, type=int)
    p.add_argument('--note', default='')
    p.add_argument('--style', choices=('accent', 'compact'), default=None)
    p.add_argument('--avatar-mode', choices=('auto', 'circle', 'closeup'), default=None)
    p.add_argument('--inset-plan', default=None, help='Source-bound editorial layout; final media QA still runs')
    p.add_argument('--resume-from', default=None, help='Reuse matching drafts; validate, render and review again')
    p.set_defaults(func=lambda args: render_precision(args, api))
    p = sub.add_parser('replace-precision', help='Replace an uploaded BV with a user-reviewed precision revision')
    p.add_argument('--id', required=True, type=int)
    p.add_argument('--revision', required=True)
    p.add_argument('--review-note', required=True)
    p.add_argument('--dry-run', action='store_true')
    p.set_defaults(func=lambda args: publish_precision(args, api))


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
    approval = {'version': 1, 'clipId': args.id, 'bvid': bvid, 'authority': 'user',
                'note': args.review_note, 'approvedAt': api.now_iso(), 'qaDigests': metadata['qaResult']['digests'],
                'metadataPath': str(directory / 'clip.json')}
    if args.dry_run:
        print(json.dumps({'action': 'replace_existing_bv', **approval}, ensure_ascii=False, indent=2))
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
        receipt_path=directory / 'REPLACEMENT_RECEIPT.json', before_submit=lambda: validate_revision(record, directory)))
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
