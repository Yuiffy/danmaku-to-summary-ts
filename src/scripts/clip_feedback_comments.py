"""Numeric-ID feedback coordinates, bound to the actual rendered subtitles/media."""
import asyncio
import copy
import hashlib
import json
import re
from pathlib import Path

try:
    from .clip_coordinate_comments import publish_coordinate_comments
except ImportError:
    from clip_coordinate_comments import publish_coordinate_comments


def file_digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def suggestion_from_subtitles(text, cue, content):
    rows = []
    pattern = r'(?m)^\d+\s*\n(\d+):(\d{2}):(\d{2})[,.](\d{3})\s*-->[^\n]*\n([^\n]*(?:\n(?!\s*\n|\d+\s*$)[^\n]+)*)'
    for match in re.finditer(pattern, text.replace('\r\n', '\n')):
        h, m, s, ms = map(int, match.groups()[:4])
        rows.append((h * 3600 + m * 60 + s + ms / 1000, match.group(5).strip()))
    if isinstance(cue, bool) or not isinstance(cue, int) or not 1 <= cue <= len(rows):
        raise ValueError('Coordinate cue must belong to the rendered clip subtitles')
    at, quote = rows[cue - 1]
    normalize = lambda value: re.sub(r'[\s，。！？、,.!?“”"「」]', '', value)
    if not isinstance(content, str) or not content.strip() or len(content) > 200 or '\0' in content:
        raise ValueError('Invalid coordinate comment content')
    if len(normalize(quote)) < 2 or normalize(quote) not in normalize(content):
        raise ValueError('Coordinate comment must quote the selected rendered subtitle')
    seconds = int(at)
    return {'timestamp': f'{seconds // 60:02d}:{seconds % 60:02d}',
            'content': content.strip(), 'sourceCueId': f'C{cue}'}


def prepare_comment(record, metadata, cue, content, note, approved_at):
    if not str(note or '').strip():
        raise ValueError('Explicit feedback authorization note is required')
    if record.get('pendingCut') or record.get('pendingRebuild') or record.get('editorialExclusion'):
        raise ValueError('Render the current clip before choosing comment coordinates')
    output = metadata.get('output') or {}
    media = output.get('mediaPath') or record.get('mediaPath')
    subtitles = output.get('srtPath') or record.get('srtPath')
    receipt = record.get('uploadState') or {}
    if receipt.get('bvid') and (record.get('precisionReplacement')
            or not receipt.get('mediaPath') or Path(receipt['mediaPath']).resolve() != Path(media).resolve()):
        raise ValueError('Published video differs from the current local edit; coordinates need its matching rendered subtitles')
    suggestion = suggestion_from_subtitles(Path(subtitles).read_text(encoding='utf-8-sig'), cue, content)
    approval = {'version': 1, 'authority': 'feedback', 'note': note, 'approvedAt': approved_at,
                'videoSha256': file_digest(media), 'subtitleSha256': file_digest(subtitles),
                'suggestions': [copy.deepcopy(suggestion)]}
    return suggestion, approval


def coordinate_comment(args, api):
    if not args.feedback_authorized:
        raise ValueError('Coordinate comments require --feedback-authorized')
    with api.queue_transaction() as queue:
        registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
        record = registry.get('clips', {}).get(str(args.id))
        if not record or args.id in api.clip_candidate_queue.active_ids(queue):
            raise ValueError('Unknown or actively queued clip ID')
        metadata_path = Path(record['metadataPath'])
        metadata = api.load_json(metadata_path, {})
        suggestion, approval = prepare_comment(record, metadata, args.cue, args.content, args.note, api.now_iso())
        metadata.setdefault('copy', {})['commentSuggestions'] = [suggestion]
        metadata['coordinateCommentApproval'] = approval
        api.save_json(metadata_path, metadata)
        record.update(commentSuggestions=[suggestion], coordinateCommentApproval=approval)
        api.save_json(api.REGISTRY_PATH, registry)
    if args.publish:
        receipt = record.get('uploadState') or {}
        if not receipt.get('bvid') or not receipt.get('aid'):
            raise ValueError('A confirmed archive receipt is required; comment saved for upload')
        # Reuse the existing uploader credential adapter and publication journal.
        try:
            from .batch_upload import build_credential
        except ImportError:
            from batch_upload import build_credential
        result = asyncio.run(publish_coordinate_comments(record, receipt, build_credential(), {},
            journal_directory=api.RUNTIME_DIR / 'clip-coordinate-comments'))
        with api.queue_transaction():
            registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
            registry['clips'][str(args.id)].setdefault('uploadState', {})['coordinateComments'] = result
            api.save_json(api.REGISTRY_PATH, registry)
        print('COORDINATE_COMMENT_RESULT: ' + json.dumps(result, ensure_ascii=False))
        return 0 if result.get('status') == 'published' else 2
    print('COORDINATE_COMMENT_RESULT: ' + json.dumps({'status': 'prepared', 'suggestion': suggestion}, ensure_ascii=False))
    return 0


def register_commands(sub, api):
    parser = sub.add_parser('coordinate-comment', help='Save a feedback-authorized rendered-video coordinate; optionally publish to its existing BV')
    parser.add_argument('--id', required=True, type=int)
    parser.add_argument('--cue', required=True, type=int)
    parser.add_argument('--content', required=True)
    parser.add_argument('--note', required=True)
    parser.add_argument('--feedback-authorized', action='store_true')
    parser.add_argument('--publish', action='store_true')
    parser.set_defaults(func=lambda args: coordinate_comment(args, api))
