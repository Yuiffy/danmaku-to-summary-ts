"""Validate bound local audio proof at final enqueue and submission boundaries; no ML or publication IO."""
import hashlib
import json
import math
from pathlib import Path


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def read(file):
    return json.loads(Path(file).read_text(encoding='utf-8-sig'))


def validate_subtitle_diagnostic(metadata, source):
    attempt = metadata.get('automaticSubtitleRepairAttempt')
    if not attempt or metadata.get('automaticSubtitleRepair'):
        return None
    file = Path(attempt['evidencePath'])
    request_file = file.parent / 'request.json'
    if attempt.get('status') != 'inconclusive' or digest(file) != attempt.get('evidenceSha256'):
        raise ValueError('subtitle diagnostic evidence changed')
    audio, request = read(file), read(request_file)
    origin = request['source']
    rows = audio.get('windows')
    if (audio.get('version') != 1 or audio.get('requestSha256') != request.get('requestSha256')
            or audio.get('source') != origin or str(Path(origin['mediaPath']).resolve()) != source['mediaPath']
            or str(origin['mediaBytes']) != source['mediaBytes']
            or abs(origin['mediaMtimeMs'] - int(source['mediaMtimeNs']) / 1e6) > .01
            or str(Path(origin['srtPath']).resolve()) != source['srtPath'] or origin['srtSha256'] != source['srtSha256']
            or not isinstance(rows, list) or not 1 <= len(rows) <= 4
            or [{k: row[k] for k in ('id', 'start', 'end')} for row in rows] != request.get('windows')):
        raise ValueError('subtitle diagnostic source or windows changed')
    for row in rows:
        decodes = row.get('decodes') or []
        if (any(type(row.get(k)) not in (int, float) or not math.isfinite(row[k]) for k in ('start', 'end'))
                or row['start'] < metadata['window']['start'] or row['end'] > metadata['window']['end']
                or not 0 < row['end'] - row['start'] <= 30 or Path(row['audioPath']).resolve().parent != file.resolve().parent
                or digest(row['audioPath']) != row.get('audioSha256') or len(decodes) != 2
                or [d.get('model') for d in decodes] != [request['settings']['model'], request['settings']['sensevoiceModel']]
                or len({d.get('model') for d in decodes}) != 2
                or any(d.get('prompted') is not False or d.get('hotwords') or d.get('useItn') is not False
                       or not isinstance(d.get('text'), str) for d in decodes)):
            raise ValueError('subtitle diagnostic audio changed')
    if sum(row['end'] - row['start'] for row in rows) > 120:
        raise ValueError('subtitle diagnostic budget exceeded')
    return hashlib.sha256((attempt['evidenceSha256'] + '\0' + digest(request_file)).encode()).hexdigest()


def validate_subtitle_audio_evidence(metadata, source, depth=0):
    repair = metadata.get('automaticSubtitleRepair')
    if not repair:
        return None
    if depth > 1:
        raise ValueError('local subtitle audio repair exceeds its probe budget')
    binding = {key: value for key, value in repair.items() if key not in ('proofPath', 'proofSha256', 'resultIdentity')}
    if (repair.get('version') != 1 or repair.get('authority') != 'automatic'
            or repair.get('method') != 'unprompted_two_model_consensus'
            or digest(repair['proofPath']) != repair.get('proofSha256') or read(repair['proofPath']) != binding
            or source != repair.get('source')
            or digest(repair['requestPath']) != repair.get('requestSha256')
            or digest(repair['evidencePath']) != repair.get('evidenceSha256')
            or digest(repair['correctedSrtPath']) != repair.get('correctedSrtSha256')):
        raise ValueError('local subtitle audio proof changed')
    audio, request = read(repair['evidencePath']), read(repair['requestPath'])
    if repair.get('previousRepair'):
        previous = repair['previousRepair']
        validate_subtitle_audio_evidence({**metadata, 'automaticSubtitleRepair': previous,
            'output': {**metadata['output'], 'srtPath': previous['correctedSrtPath']}}, source, depth + 1)
    edits = repair.get('edits')
    if (audio.get('requestSha256') != request.get('requestSha256') or audio.get('source') != request.get('source')
            or audio.get('windows') != repair.get('checks') or not isinstance(edits, list) or not 1 <= len(edits) <= 4):
        raise ValueError('local subtitle audio checks differ from their proof')
    for row in repair['checks']:
        decodes = row.get('decodes') or []
        if (digest(row['audioPath']) != row.get('audioSha256') or len(decodes) != 2
                or len({decode.get('model') for decode in decodes}) != 2
                or any(decode.get('prompted') is not False or decode.get('hotwords')
                       or decode.get('useItn') is not False for decode in decodes)):
            raise ValueError('local subtitle audio model evidence changed')
    if (any(edit['from'] != edit['to'] for edit in edits)
            and digest(metadata['output']['srtPath']) != repair.get('correctedSrtSha256')):
        raise ValueError('rendered subtitles differ from local audio correction')
    return repair['proofSha256']
