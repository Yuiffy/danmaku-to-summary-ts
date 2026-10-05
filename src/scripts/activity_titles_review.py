"""Validate song names against reviewed original transcript evidence and public titles."""
import re
from pathlib import Path
try:
    from .audit_bilibili_clip import parse_srt
except ImportError:
    from audit_bilibili_clip import parse_srt


def check_title_evidence(metadata, activities, digest):
    evidence = (metadata.get('presentation') or {}).get('titleEvidence')
    items = (evidence.get('items') or [evidence]) if evidence else []
    if len({i.get('activityId') for i in items}) != len(items):
        raise ValueError('activity public title evidence repeats an activity')
    normalize = lambda s: ''.join(c for c in str(s or '').lower() if c.isalnum())
    for item in items:
        event = activities.get(item.get('activityId'))
        if not event or not str(item.get('name') or '').strip() or not str(item.get('note') or '').strip():
            raise ValueError('activity public title evidence is invalid')
        if item.get('method') == 'source_frame_reading':
            if digest(item['framePath']) != item.get('frameSha256'):
                raise ValueError('activity public title evidence changed')
        elif item.get('method') == 'source_transcript_reading':
            transcript = metadata.get('transcript') or {}
            if (item.get('transcriptPath') != transcript.get('path') or item.get('transcriptSha256') != transcript.get('sha256')
                    or digest(item['transcriptPath']) != item['transcriptSha256']):
                raise ValueError('activity public title transcript evidence changed')
            rows = parse_srt(item['transcriptPath'])
            segments = item.get('segments') or []
            if not segments or any(not isinstance(s.get('index'), int) or not 1 <= s['index'] <= len(rows)
                    or s != {'index': s['index'], **rows[s['index']-1]} or s['end'] < event['start']-300
                    or s['start'] > event['end']+60 for s in segments):
                raise ValueError('activity public title evidence differs from its original transcript rows')
            alias = normalize(item.get('sourceAlias') or item['name'])
            if len(alias) < 2 or alias not in normalize(' '.join(s['text'] for s in segments)):
                raise ValueError('activity public title is absent from its original evidence')
        else:
            raise ValueError('activity public title evidence method is invalid')
    return {item['activityId']: item['name'] for item in items}


def check_song_titles(metadata, activities, names):
    presentation = metadata.get('presentation') or {}
    if presentation.get('version', 1) < 2:
        return
    date = presentation.get('recordingDate') or ''
    if presentation.get('titleFormat') != 'song_name_recording_date' or not re.fullmatch(r'\d{4}\.([1-9]|1[0-2])\.([1-9]|[12]\d|3[01])', date):
        raise ValueError('song public title needs its recording date')
    match = re.search(r'-(\d{8})-\d{6}-', Path(metadata['sourceSnapshot']['mediaPath']).name)
    if match and date != f'{match[1][:4]}.{int(match[1][4:6])}.{int(match[1][6:8])}':
        raise ValueError('song public title date differs from its recording')
    ordered = []
    for part in metadata['output']['parts']:
        name = names.get(part['activityId']) or activities[part['activityId']].get('name')
        if not name or part['title'] != f'{name}-{date}':
            raise ValueError('song name is unresolved or P title lacks the verified name and date')
        if name not in ordered:
            ordered.append(name)
    expected = f'{" / ".join(ordered)}-{date}'
    limit = 80 - len((metadata.get('upload') or {}).get('prefix') or '')
    if len(expected) > limit:
        expected = f'{ordered[0]}等{len(ordered)}首-{date}'
    if metadata['copy']['title'] != expected:
        raise ValueError('song submission title differs from its verified song names and date')


def check_watch_titles(metadata, activities, names):
    presentation = metadata.get('presentation') or {}
    if presentation.get('version', 1) < 3:
        return
    date = presentation.get('recordingDate') or ''
    if presentation.get('titleFormat') != 'work_name_recording_date' or not re.fullmatch(r'\d{4}\.([1-9]|1[0-2])\.([1-9]|[12]\d|3[01])', date):
        raise ValueError('viewing public title needs its recording date')
    match = re.search(r'-(\d{8})-\d{6}-', Path(metadata['sourceSnapshot']['mediaPath']).name)
    if match and date != f'{match[1][:4]}.{int(match[1][4:6])}.{int(match[1][6:8])}':
        raise ValueError('viewing public title date differs from its recording')
    parts = metadata['output']['parts']
    ordered = []
    for part in parts:
        name = names.get(part['activityId']) or activities[part['activityId']].get('name')
        if not name or name in ('待确认片名', '电影同看', '剧集同看', '本场同看', '同步视听'):
            raise ValueError('viewing work name is unresolved; review the title before publication')
        group = [p for p in parts if p['activityId'] == part['activityId']]
        if part['title'] != f'《{name}》 {group.index(part)+1:02d}/{len(group):02d}':
            raise ValueError('viewing P title differs from its verified work name and order')
        if name not in ordered:
            ordered.append(name)
    expected = f'{" / ".join(f"《{name}》" for name in ordered)}｜{date}'
    limit = 80 - len((metadata.get('upload') or {}).get('prefix') or '')
    if len(expected) > limit:
        expected = f'《{ordered[0]}》等{len(ordered)}部｜{date}'
    if metadata['copy']['title'] != expected:
        raise ValueError('viewing submission title differs from its verified work names and date')
