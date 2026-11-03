"""Source-bound review and single-ID registration for explicit keyword bundles."""
import argparse
import copy
import hashlib
import json
from pathlib import Path


def _read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def _digest(path):
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def _snapshot(source):
    media = Path(source['mediaPath']).resolve()
    stat = media.stat()
    return dict(mediaPath=str(media), mediaBytes=str(stat.st_size), mediaMtimeNs=str(stat.st_mtime_ns),
                srtPath=str(Path(source['srtPath']).resolve()), srtSha256=_digest(source['srtPath']),
                xmlPath=str(Path(source['xmlPath']).resolve()) if source.get('xmlPath') else None,
                xmlSha256=_digest(source['xmlPath']) if source.get('xmlPath') else None)


def validate_bundle(metadata, *, require_approval=True):
    bundle = metadata.get('candidateBundle') or {}
    ids, mappings = bundle.get('ids', []), bundle.get('mappings', [])
    if (metadata.get('mode') != 'keyword_topic_bundle' or metadata.get('publicationKind') != 'keyword_topic_bundle'
            or bundle.get('version') != 1 or not 2 <= len(ids) <= 5 or len(set(ids)) != len(ids)
            or any(type(i) is not int or i < 1 for i in ids)
            or {row.get('id') for row in mappings} != set(ids) or len(mappings) != len(ids)):
        raise ValueError('Invalid numeric bundle membership')
    members_path = Path(bundle.get('membersPath', ''))
    if _digest(members_path) != bundle.get('membersSha256'):
        raise ValueError('Bundle member evidence changed')
    members = _read(members_path).get('members', [])
    if len(members) != len(ids) or {row.get('id') for row in members} != set(ids):
        raise ValueError('Bundle member manifest differs')
    source_paths = set()
    for member in members:
        if (_digest(member['metadataPath']) != member.get('metadataSha256')
                or _digest(member['candidateSrtPath']) != member.get('candidateSrtSha256')):
            raise ValueError('Original candidate changed after bundle rendering')
        original = _read(member['metadataPath'])
        source, expected = original['source'], member['sourceSnapshot']
        source_paths.add(str(Path(source['mediaPath']).resolve()))
        stat = Path(source['mediaPath']).stat()
        if (str(Path(source['mediaPath']).resolve()) != str(Path(expected['mediaPath']).resolve())
                or stat.st_size != expected['bytes'] or abs(stat.st_mtime_ns / 1e6 - expected['mtimeMs']) > .001
                or _digest(source['srtPath']) != expected['srtSha256']
                or (source.get('xmlPath') and _digest(source['xmlPath']) != expected.get('xmlSha256'))):
            raise ValueError('Original recording or transcript changed')
        mapping = next(row for row in mappings if row['id'] == member['id'])
        if mapping.get('originalWindow') != original.get('window'):
            raise ValueError('Bundle original source window changed')
        keep = (metadata.get('editPlan') or {}).get('keep', [])
        if not mapping.get('keywordSpans') or any(not any(
                span['start'] <= cue['start'] + .002 and span['end'] >= cue['end'] - .002 for span in keep)
                for cue in mapping['keywordSpans']):
            raise ValueError('Bundle omitted member keyword evidence')
    if len(source_paths) != 1 or bundle.get('originalSourceMediaPath') and bundle['originalSourceMediaPath'] not in source_paths:
        raise ValueError('Bundle must refer to one original recording')
    creative, qa, audio = (metadata.get(key) or {} for key in ('creativeResult', 'qaResult', 'audioQa'))
    if (creative.get('status') != 'edited' or qa.get('status') != 'passed' or qa.get('issues')
            or metadata.get('qaRequired') is not True or audio.get('status') != 'passed' or audio.get('issues')
            or not metadata.get('output', {}).get('burnedSubtitles')):
        raise ValueError('Bundle precision, visual and audio checks must pass')
    if require_approval:
        review = metadata.get('bundlePublicationReview') or {}
        if (review.get('authority') != 'user' or not str(review.get('note') or '').strip()
                or review.get('memberIds') != ids or review.get('qaDigests') != qa.get('digests')
                or review.get('membersSha256') != bundle.get('membersSha256') or bundle.get('uploadAuthorized') is not True
                or review.get('source') != _snapshot(metadata['source'])):
            raise ValueError('Bundle requires current source-bound user publication approval')
    return next(iter(source_paths))


def approve_bundle(args, api):
    """Review one final artifact, import once, and absorb its unqueued members."""
    if not str(args.review_note).strip():
        raise ValueError('User publication authorization note is required')
    directory = Path(args.revision).resolve()
    result = _read(directory / 'RESULT.json')
    metadata_path = Path(result['metadataPath']).resolve()
    if result.get('status') != 'pending_review' or not metadata_path.is_relative_to(directory):
        raise ValueError('Select a completed pending-review bundle')
    metadata = _read(metadata_path)
    original_source = validate_bundle(metadata, require_approval=False)
    # This uses the renderer's exact JS source identity, including its timestamp serialization.
    command = ['node', str(api.PROJECT_ROOT / 'src/scripts/clipping/precision_bundle.js'),
               '--project-root', str(api.PROJECT_ROOT), '--check-source', '--metadata', str(metadata_path)]
    checked = api.subprocess.run(command, cwd=api.PROJECT_ROOT, capture_output=True, encoding='utf-8',
                                 errors='replace', timeout=60, **api.hidden_subprocess_kwargs())
    lines = [line for line in checked.stdout.splitlines() if line.startswith('BUNDLE_SOURCE: ')]
    if checked.returncode or len(lines) != 1:
        raise ValueError(checked.stderr.strip() or 'Cannot verify rendered bundle source')
    source_snapshot = json.loads(lines[0].removeprefix('BUNDLE_SOURCE: '))
    # All revisions of these same members share one publication path and numeric ID.
    publication = directory.parent / 'PUBLICATION.json'
    with api.queue_transaction() as queue:
        registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
        existing = [row for row in registry.get('clips', {}).values() if api.paths_match(row.get('metadataPath', ''), publication)]
        active = api.clip_candidate_queue.active_ids(queue)
        if existing:
            row = existing[0]
            if row.get('status') == 'uploaded' or row.get('uploadState', {}).get('bvid') or row['id'] in active:
                print(f"[OK] bundle already registered/queued/published as ID{row['id']}; no change")
                return 0
        for member_id in metadata['candidateBundle']['ids']:
            row = registry.get('clips', {}).get(str(member_id))
            exclusion = (row or {}).get('editorialExclusion') or {}
            if (not row or member_id in active or row.get('status') == 'uploaded' or row.get('uploadState', {}).get('bvid')
                    or exclusion and exclusion.get('bundlePublicationPath') != str(publication)):
                raise ValueError(f'Member ID{member_id} is published, queued or independently excluded')
        approved = copy.deepcopy(metadata)
        approved['candidateBundle'].update(originalSourceMediaPath=original_source, uploadAuthorized=True)
        approved['bundlePublicationReview'] = dict(authority='user', note=args.review_note, approvedAt=api.now_iso(),
            memberIds=approved['candidateBundle']['ids'], qaDigests=approved['qaResult']['digests'],
            membersSha256=approved['candidateBundle']['membersSha256'], source=source_snapshot, audioVisualReviewed=False)
        approved['uploadReady'] = True
        approved['output']['metadataPath'] = str(publication)
        try:
            from .clip_qa import validate_metadata_qa
            from .clip_upload_json import import_json
        except ImportError:
            from clip_qa import validate_metadata_qa
            from clip_upload_json import import_json
        validate_metadata_qa(approved)
        api.save_json(publication, approved)
        imported = import_json(argparse.Namespace(manifest=str(publication), review='', state='', source='',
            prefix='', tags='', tid=None, label='', batch_id=''), api)
        if imported:
            return imported
        registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
        for member_id in approved['candidateBundle']['ids']:
            registry['clips'][str(member_id)].update(status='cancelled', updatedAt=api.now_iso(), editorialExclusion={
                'reason': 'Absorbed into the user-approved dual-topic precision submission',
                'excludedAt': api.now_iso(), 'bundlePublicationPath': str(publication)})
        api.save_json(api.REGISTRY_PATH, registry)
    print('[OK] one bundle registered; original member IDs excluded; upload is NOT queued')
    return 0
