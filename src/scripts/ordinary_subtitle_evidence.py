"""Validate bound local audio proof at final enqueue and submission boundaries; no ML or publication IO."""
import hashlib
import json
from pathlib import Path


def digest(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def read(file):
    return json.loads(Path(file).read_text(encoding='utf-8-sig'))


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
