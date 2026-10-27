"""Replace one reviewed page of an existing archive without creating another submission."""
import copy
import hashlib
import datetime as dt
import json
import re
import sys
import uuid
from pathlib import Path


def validate_replacement_revision(metadata, clip_id):
    if metadata.get('uploadId') != clip_id or metadata.get('ownStreamHumanReview'):
        raise ValueError('A same-ID independently reviewed revision is required')
    if metadata.get('renderedTimingRepair'):
        return
    revision = metadata.get('renderedSubtitles') or {}
    output = metadata.get('output') or {}
    if (metadata.get('rebuildRequired') or revision.get('clipId') != clip_id
            or not isinstance(revision.get('revision'), int) or revision['revision'] < 1
            or revision.get('renderedRevision') != revision['revision']
            or not revision.get('edits') or not revision.get('sha256')
            or revision.get('renderedSha256') != revision['sha256']):
        raise ValueError('A completed same-ID subtitle revision is required')
    for file in (revision.get('path'), output.get('srtPath')):
        if not file or hashlib.sha256(Path(file).read_bytes()).hexdigest() != revision['sha256']:
            raise ValueError('Rendered subtitle revision changed; rebuild before replacement')


def edit_payload(detail, uploaded, cover, metadata):
    archive = detail['archive']
    if len(detail.get('videos') or []) != 1 or (detail.get('replace_check') or {}).get('can_replace') is not True:
        raise ValueError('Media replacement requires one existing replaceable page')
    if archive.get('attribute', 0) != 0 or (detail.get('reply') or {}).get('state', 0) not in (0, 1):
        raise ValueError('Unsupported existing archive/reply controls; cannot safely preserve them')
    page = detail['videos'][0]
    if not uploaded.get('filename') or not uploaded.get('cid') or uploaded['filename'] == page['filename']:
        raise ValueError('A different uploaded media file and CID are required')
    desc = archive.get('desc', '')
    # Preserve all human copy; update only the generated, now-incorrect source-time line.
    if metadata.get('type') != 'social_post_video':
        recorded = dt.datetime.fromisoformat(metadata['recordedAt'])
        start, end = metadata['window']['start'], metadata['window']['end']
        line = ('切片时间：' + (recorded + dt.timedelta(seconds=start)).strftime('%H:%M:%S') + ' - '
                + (recorded + dt.timedelta(seconds=end)).strftime('%H:%M:%S') + f'（直播开始后第{int(start // 60)}分钟）')
        desc = re.sub(r'切片时间：\d{2}:\d{2}:\d{2} - \d{2}:\d{2}:\d{2}（直播开始后第\d+分钟）', line, desc)
    meta = {key: copy.deepcopy(archive.get(key)) for key in ('title', 'copyright', 'source', 'tag', 'desc_format_id',
        'dynamic', 'tid', 'no_reprint', 'no_public', 'is_only_self', 'is_space_hidden', 'lossless_music') if key in archive}
    meta.update({'aid': archive['aid'], 'cover': cover, 'desc': desc, 'interactive': 0, 'new_web_edit': 1,
        'handle_staff': False, 'topic_grey': 1, 'web_os': 2,
        'origin_state': detail.get('origin_state', 0), 'act_reserve_create': detail.get('act_reserve_create', False),
        'no_disturbance': detail.get('no_disturbance', 0),
        'open_elec': int((detail.get('arc_elec') or {}).get('state', 1) == 0),
        'up_close_reply': (detail.get('reply') or {}).get('state', 0) == 1,
        'up_selection_reply': (detail.get('reply') or {}).get('up_selection', False), 'up_close_danmu': False,
        'subtitles': {'lan': (detail.get('subtitle') or {}).get('lan', ''),
                      'open': int(bool((detail.get('subtitle') or {}).get('allow', False)))},
        'videos': [{'title': page['title'], 'desc': page.get('desc', ''),
                    'filename': uploaded['filename'], 'cid': uploaded['cid']}]})
    return meta


def unchanged_archive(expected, current):
    for key in ('archive', 'videos', 'reply', 'subtitle', 'origin_state', 'arc_elec', 'space_hidden', 'no_disturbance'):
        if expected.get(key) != current.get(key):
            raise ValueError('Existing archive changed during preparation; reload before replacing media')


def record_replacement(clip, metadata, result, state, note, now, metadata_path=None):
    clip, state = copy.deepcopy(clip), copy.deepcopy(state)
    clip['mediaReplacement'] = {**result, 'authority': 'user_requested_media_replacement', 'note': note, 'at': now,
        'previousUploadState': copy.deepcopy(clip['uploadState']), 'mediaPath': metadata['output']['mediaPath']}
    if metadata_path:
        clip['mediaReplacement'].update(metadataPath=str(metadata_path), previousMetadataPath=clip['metadataPath'])
    if result['status'] == 'confirmed':
        clip['uploadState'].update(cid=result['cid'], mediaPath=metadata['output']['mediaPath'], cover=metadata['output']['coverPath'])
        clip.update(reviewPending=False, reviewIssues=[], pendingRebuild=False, publicCopyPending=False)
        if metadata_path:
            seconds = round(metadata['window']['duration'])
            clip.update(metadataPath=str(metadata_path), manifestPath=str(metadata_path), **metadata['output'],
                        duration=f'{seconds // 3600:02}:{seconds // 60 % 60:02}:{seconds % 60:02}')
        if clip.get('automaticPublicationAuthorization'):
            clip['replacedPublicationAuthorization'] = clip.pop('automaticPublicationAuthorization')
        for row in (state.get('done') or {}).values():
            if row.get('bvid') == result['bvid']:
                row.update(cid=result['cid'], mediaPath=metadata['output']['mediaPath'], cover=metadata['output']['coverPath'])
                row['mediaReplacement'] = {key: result[key] for key in ('filename', 'cid', 'status', 'isOnlySelf')}
    clip['status'], clip['updatedAt'] = 'uploaded', now
    return clip, state


async def replace_existing(clip, metadata, directory, auth_path):
    from bilibili_api.video_uploader import VideoUploader, VideoUploaderPage, VideoEditor, upload_cover, _choose_line
    from bilibili_api.utils.picture import Picture
    try:
        from .update_cover import load_auth, fetch_archive, normalize_cover_url
        from .clip_auto_publication import validate_publication_review
        from .social_post_review import validate_social_post_review
    except ImportError:
        from update_cover import load_auth, fetch_archive, normalize_cover_url
        from clip_auto_publication import validate_publication_review
        from social_post_review import validate_social_post_review
    bvid = clip['uploadState']['bvid']
    cookie, credential = load_auth(auth_path)
    before = fetch_archive(cookie, bvid)
    # Preflight controls before any media upload, using a harmless dummy file identity.
    edit_payload(before, {'filename': 'preflight-only', 'cid': 1}, before['archive']['cover'], metadata)
    write = lambda name, value: (directory / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    write('BEFORE.json', before)
    page = VideoUploaderPage(metadata['output']['mediaPath'], before['videos'][0]['title'])
    uploader = VideoUploader([page], {}, credential, cover=metadata['output']['coverPath'])
    uploader.line = await _choose_line(uploader.line)
    uploaded = await uploader._upload_page(page)  # Deliberately no uploader.start() or new-archive submission.
    write('UPLOADED.json', uploaded)
    cover = normalize_cover_url(await upload_cover(Picture().from_file(metadata['output']['coverPath']), credential))
    current = fetch_archive(cookie, bvid)
    unchanged_archive(before, current)
    if json.loads(Path(clip['metadataPath']).read_text(encoding='utf-8-sig')) != metadata:
        raise ValueError('Reviewed local metadata changed during upload')
    if metadata.get('type') == 'social_post_video':
        validate_social_post_review(metadata)
    else:
        validate_publication_review(metadata)
    payload = edit_payload(current, uploaded, cover, metadata)
    editor = VideoEditor(bvid, payload, credential=credential)
    write('EDIT.json', copy.deepcopy(payload))  # Before _submit adds CSRF; never persist credentials.
    write('SUBMIT_INTENT.json', {'bvid': bvid, 'filename': uploaded['filename'], 'cid': uploaded['cid']})
    await editor._submit()
    write('SUBMITTED.json', {'bvid': bvid, 'cid': uploaded['cid'], 'filename': uploaded['filename']})
    after = fetch_archive(cookie, bvid)
    write('AFTER.json', after)
    matched = len(after.get('videos') or []) == 1 and after['videos'][0]['filename'] == uploaded['filename']
    private = after['archive'].get('is_only_self', 0) == before['archive'].get('is_only_self', 0)
    if not private:
        raise ValueError('Platform response did not confirm preserved visibility')
    return {'bvid': bvid, 'aid': before['archive']['aid'], 'cid': uploaded['cid'], 'filename': uploaded['filename'],
            'status': 'confirmed' if matched else 'submitted', 'isOnlySelf': after['archive'].get('is_only_self', 0),
            'platformState': after['archive'].get('state'), 'evidenceDirectory': str(directory)}


def run(args, api):
    import asyncio
    try:
        from .clip_auto_publication import validate_publication_review
        from .social_post_review import validate_social_post_revision, validate_social_post_review
    except ImportError:
        from clip_auto_publication import validate_publication_review
        from social_post_review import validate_social_post_revision, validate_social_post_review
    handle = api.acquire_queue_mutation_lock()
    try:
        registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
        clip = registry.get('clips', {}).get(str(args.id))
        if (not clip or not (clip.get('uploadState') or {}).get('bvid')
                or clip['uploadState']['bvid'] != args.expected_bvid or clip.get('pendingRebuild')):
            raise ValueError('A published original ID/BV and completed local rebuild are required')
        revision_path = Path(args.manifest).resolve() if getattr(args, 'manifest', None) else None
        original = api.load_json(Path(clip['metadataPath']), {})
        metadata = api.load_json(revision_path, {}) if revision_path else original
        if revision_path:
            if clip.get('publicationKind') != 'social_post' or not clip.get('socialReviewRequired'):
                raise ValueError('--manifest supports only reviewed social-post revisions')
            if (clip.get('mediaReplacement') or {}).get('mediaPath') == metadata.get('output', {}).get('mediaPath'):
                validate_social_post_review(metadata)
            else:
                validate_social_post_revision(original, metadata)
        else:
            validate_replacement_revision(metadata, args.id)
            validate_publication_review(metadata)
        if not args.note.strip():
            raise ValueError('A substantive replacement note is required')
        previous = clip.get('mediaReplacement') or {}
        if previous.get('mediaPath') == metadata['output']['mediaPath']:
            print('MEDIA_REPLACEMENT_RESULT: ' + json.dumps(previous, ensure_ascii=False))
            return 0
        root = (revision_path or Path(clip['metadataPath'])).parent / 'temp' / 'media-replacements'
        for intent in root.glob(f'{args.id}-*/SUBMIT_INTENT.json'):
            prior = api.load_json(intent.with_name('INPUT.json'), {})
            if prior.get('mediaPath') == metadata['output']['mediaPath']:
                raise ValueError(f'An earlier edit may already be submitted; reconcile its receipt before retrying: {intent.parent}')
        directory = root / f'{args.id}-{uuid.uuid4()}'
        directory.mkdir(parents=True)
        api.save_json(directory / 'INPUT.json', {'id': args.id, 'bvid': args.expected_bvid, 'mediaPath': metadata['output']['mediaPath']})
        upload_clip = {**clip, 'metadataPath': str(revision_path)} if revision_path else clip
        result = asyncio.run(replace_existing(upload_clip, metadata, directory, api.PROJECT_ROOT / 'config' / 'secret.json'))
        state_path = Path(clip['statePath'])
        updated, state = record_replacement(clip, metadata, result, api.load_json(state_path, {}), args.note, api.now_iso(), revision_path)
        registry['clips'][str(args.id)] = updated
        api.save_json(state_path, state)
        api.save_json(api.REGISTRY_PATH, registry)
        print('MEDIA_REPLACEMENT_RESULT: ' + json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyError) as error:
        print(f'[ERROR] {error}', file=sys.stderr)
        return 2
    finally:
        api.release_queue_mutation_lock(handle)


def add_command(sub, api):
    parser = sub.add_parser('replace-media', help='Replace a reviewed timing revision in its existing BV; preserve visibility')
    parser.add_argument('--id', required=True, type=int)
    parser.add_argument('--expected-bvid', required=True)
    parser.add_argument('--note', required=True)
    parser.add_argument('--manifest', help='Reviewed social-post timing/presentation revision; retain the original ID/BV and online copy')
    parser.set_defaults(func=lambda args: run(args, api))
