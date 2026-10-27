"""Read-only source-window checks shared by enqueue and upload preflight."""

import math
import ntpath
import re


def _seconds(value):
    try:
        result = 0.0
        for part in str(value).split(':'):
            result = result * 60 + float(part)
        return result if math.isfinite(result) and result >= 0 else None
    except (TypeError, ValueError):
        return None


def _source_keys(clip, metadata):
    if (clip.get('publicationKind') or metadata.get('publicationKind')) == 'social_post':
        url = (metadata.get('source') or {}).get('url') or clip.get('source')
        return {('social_post', str(url).split('?')[0].split('#')[0].rstrip('/'))} if url else set()
    source = clip.get('sourceMediaPath') or (metadata.get('source') or {}).get('mediaPath')
    keys = set()
    if source:
        normalized = ntpath.normcase(ntpath.normpath(source))
        keys.add(('path', normalized))
        name = ntpath.basename(normalized)
        if re.match(r'录制-\d+-\d{8}-\d{6}-\d+-', name):
            keys.add(('recording', name))
    # Historical REVIEW imports have no sourceMediaPath or metadata sidecar.
    media = str(clip.get('mediaPath') or '')
    match = re.search(r'录制-(\d+)-\d{8}-\d{6}-\d+-', media)
    room = str(clip.get('roomId') or (match.group(1) if match else ''))
    if room and clip.get('source'):
        keys.add(('label', room, clip['source']))
    return keys


def _purpose(clip, metadata):
    kind = metadata.get('type')
    prefix = str(clip.get('prefix') or '')
    if (clip.get('publicationKind') or metadata.get('publicationKind')) == 'social_post':
        return ('social_post',)
    if (clip.get('publicationKind') or metadata.get('publicationKind')) == 'game_highlight_compilation':
        return ('compilation',)
    if (clip.get('activityReviewRequired') or kind == 'stream_activity_submission'
            or prefix in ('【岁己同步视听】', '【岁己歌切】')):
        activity = metadata.get('kind') or ('watch' if '同步视听' in prefix else 'songs' if '歌切' in prefix else prefix)
        return ('activity', activity)
    if clip.get('gameReviewRequired') or kind == 'stream_game_submission':
        return ('game',)
    if kind == 'danmaku_replay':
        return ('replay',)
    return ('ordinary',)


def _ranges(clip, metadata):
    # A social post has one source identity, independent of rendered hold times.
    if _purpose(clip, metadata) == ('social_post',):
        return [(0, 1)]
    # A multi-recording compilation's output clock is not a source interval.
    if _purpose(clip, metadata) == ('compilation',):
        return []
    window = metadata.get('window') or {}
    items = (metadata.get('parts') or clip.get('parts')) if _purpose(clip, metadata) != ('ordinary',) else None
    items = items or [window if window else clip]
    result = []
    for item in items:
        start, end = _seconds(item.get('start')), _seconds(item.get('end'))
        duration = _seconds(item.get('duration'))
        if start is not None and end is None and duration is not None:
            end = start + duration
        if start is not None and end is not None and end > start:
            result.append((start, end))
    return result


def _coverage(ranges):
    result = []
    for start, end in sorted(ranges):
        if result and start <= result[-1][1]:
            result[-1] = (result[-1][0], max(end, result[-1][1]))
        else:
            result.append((start, end))
    return result


def _overlaps(left, right):
    left, right = _coverage(left), _coverage(right)
    if not left or not right:
        return False
    overlap = sum(max(0, min(b, d) - max(a, c)) for a, b in left for c, d in right)
    shorter = min(sum(b - a for a, b in left), sum(b - a for a, b in right))
    return overlap > .001 and (overlap / shorter >= .98 or overlap >= 10 and overlap / shorter >= .5)


def duplicate_errors(clips, records, read_metadata):
    """Titles, numeric IDs, feedback acceptance and render paths cannot bypass this gate.

    Compare all selected clips with each other and with published/queued peers.
    Complete archives and ordinary highlights intentionally have separate purposes.
    IO is injected; no registry, queue, metadata or publication receipt is changed.
    """
    clips = list(clips)
    selected = {str(clip.get('id')) for clip in clips}
    cache = {}

    def describe(clip):
        key = str(clip.get('metadataPath') or '')
        if key not in cache:
            cache[key] = read_metadata(key) if key else {}
        metadata = cache[key]
        return _source_keys(clip, metadata), _purpose(clip, metadata), _ranges(clip, metadata)

    def reserved(peer):
        if (peer.get('status') in ('uploaded', 'uploading', 'queued') or peer.get('bvid') or peer.get('aid')
                or (peer.get('uploadState') or {}).get('bvid') or (peer.get('uploadState') or {}).get('aid')):
            return True
        state_path = str(peer.get('statePath') or '')
        if not state_path:
            return False
        if state_path not in cache:
            cache[state_path] = read_metadata(state_path)
        intents = cache[state_path].get('submission_intents') or {}
        media = peer.get('mediaPath')
        return any(isinstance(intent, dict) and media and intent.get('mediaPath') and
                   ntpath.normcase(ntpath.normpath(media)) == ntpath.normcase(ntpath.normpath(intent['mediaPath']))
                   for intent in intents.values())

    peers = [peer for peer in records if str(peer.get('id')) not in selected]
    errors = []
    for clip in clips:
        keys, purpose, ranges = describe(clip)
        for peer in peers:
            media = clip.get('mediaPath')
            same_media = bool(media and peer.get('mediaPath') and
                              ntpath.normcase(ntpath.normpath(media)) == ntpath.normcase(ntpath.normpath(peer['mediaPath'])))
            # Most recordings can be eliminated without reading their sidecars.
            peer_keys = _source_keys(peer, {})
            if (not same_media and peer_keys and keys and not keys.intersection(peer_keys)
                    and (peer.get('sourceMediaPath') or not peer.get('metadataPath'))):
                continue
            if str(peer.get('id')) not in selected and not reserved(peer):
                continue
            other_keys, other_purpose, other_ranges = describe(peer)
            if purpose == other_purpose and (same_media or
                    keys.intersection(other_keys) and _overlaps(ranges, other_ranges)):
                errors.append(f"duplicate source content: clip {clip.get('id')} overlaps clip {peer.get('id')} "
                              f"({(peer.get('uploadState') or {}).get('bvid') or peer.get('bvid') or peer.get('status')})")
                break
        peers.append(clip)
    return errors
