"""Preparation-only cuts require original context and a separately verified game witness."""
import json
import math
import re
from pathlib import Path

FLAGS = ('actualLocalSetup', 'targetGameEstablished', 'earlierContextUnrelated', 'laterContextUnrelated',
         'allPreparationRetained', 'retainedContentAllowed', 'publicCopySupported')


def preparation_boundary(review, rows):
    context, witness = review.get('contextReview') or {}, review.get('witnessEvent') or {}
    verdict = witness.get('verification') or {}
    number = lambda v: not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v)
    if (review.get('version') != 1 or review.get('method') != 'independent_preparation_context'
            or context.get('decision') != 'keep' or not str(context.get('reason') or '').strip()
            or any(context.get(k) is not True for k in FLAGS)):
        raise ValueError('independent game preparation remains uncertain')
    if (witness.get('gameId') != review.get('gameId') or verdict.get('decision') != 'keep' or verdict.get('version') != 4
            or verdict.get('protocolVersion', 0) < 13 or verdict.get('evidenceMethod') != 'independent_local_asr'
            or verdict.get('verificationKind') == 'preparation_only' or verdict.get('publicCopySupported') is not True
            or not all(number(witness.get(k)) for k in ('start', 'end')) or witness['start'] != verdict.get('start')
            or witness['end'] != verdict.get('end') or witness['start'] <= review['window']['end']
            or not any(f.get('activity') == 'gameplay' and witness['start'] <= t < witness['end']
                       for f, t in zip(verdict.get('frameObservations') or [], verdict.get('frameTimes') or []))):
        raise ValueError('preparation needs separately verified same-source target gameplay')
    def bound(value):
        index = value.get('transcriptIndex') if isinstance(value, dict) else None
        if not isinstance(index, int) or isinstance(index, bool) or not 1 <= index <= len(rows):
            raise ValueError('preparation row is not bound to complete independent ASR')
        row = rows[index-1]
        if value != dict(transcriptIndex=index, **{k: row[k] for k in ('start', 'end', 'text')}):
            raise ValueError('preparation row is not bound to complete independent ASR')
        return row
    first, last = bound(context.get('firstRetainedRow')), bound(context.get('lastRetainedRow'))
    if (not review['window']['start'] <= first['start'] < last['end'] <= review['window']['end']-2
            or context['firstRetainedRow']['transcriptIndex'] > context['lastRetainedRow']['transcriptIndex']):
        raise ValueError('preparation lacks complete surrounding context')
    return dict(start=first['start'], end=last['end'])


def validate_preparation(event, source, duration, game_id, digest, read_audio, extraction, validate_witness):
    verdict = event.get('verification') or {}; review = verdict.get('preparationReview') or {}
    identity = {k: source[k] for k in ('mediaPath', 'mediaBytes', 'mediaMtimeNs')}
    primary = review.get('primary') or {}; context = review.get('contextReview') or {}
    if (verdict.get('version') != 4 or verdict.get('protocolVersion', 0) < 14
            or verdict.get('evidenceMethod') != 'independent_local_asr' or verdict.get('verificationKind') != 'preparation_only'
            or verdict.get('decision') != 'keep' or verdict.get('publicCopySupported') is not True
            or verdict.get('startObserved') is not True or verdict.get('endObserved') is not True
            or review.get('source') != identity or review.get('gameId') != game_id or event.get('gameId') != game_id
            or (review.get('candidate') or {}).get('id') != event.get('id')
            or review.get('window') != dict(start=primary.get('start'), end=primary.get('end'))
            or not 0 <= primary.get('start', -1) < primary.get('end', -1) <= duration):
        raise ValueError('game preparation source or authority changed')
    rows = read_audio(primary, source)
    boundary = preparation_boundary(review, rows)
    if (review.get('boundary') != boundary or verdict.get('start') != boundary['start'] or verdict.get('end') != boundary['end']
            or review.get('chapters') != event.get('chapters')):
        raise ValueError('game preparation boundaries or copy changed')
    witness = review['witnessEvent']; validate_witness(witness)
    frames = review.get('frames') or []
    if not 1 <= len(frames) <= 8:
        raise ValueError('game preparation original frames are missing')
    actual = [s for s, f in zip(witness['verification']['originalFrameEvidence'], witness['verification']['frameObservations'])
              if f['activity'] == 'gameplay' and witness['start'] <= s['time'] < witness['end']]
    if not any(any(s['time'] == a['time'] and s['sha256'] == a['sha256'] for a in actual) for s in frames):
        raise ValueError('game preparation lacks the actual witness gameplay frame')
    for sample in frames:
        if digest(sample['path']) != sample.get('sha256'):
            raise ValueError('game preparation original frame changed')
        extraction(sample['path'], source, sample['time'])
    if digest(context['responsePath']) != context.get('responseSha256'):
        raise ValueError('game preparation original assessment changed')
    raw = json.loads(Path(context['responsePath']).read_text(encoding='utf-8-sig'))
    parsed = json.loads(re.sub(r'\s*```$', '', re.sub(r'^```(?:json)?\s*', '', raw['text'].strip())))
    binding = {k: review[k] for k in ('source', 'gameId', 'candidate', 'window', 'primary', 'frames', 'chapters', 'witnessEvent')}
    binding['version'] = 1
    if raw.get('requestBinding') != binding or any(parsed.get(k) != context.get(k) for k in ('decision', 'reason', *FLAGS, 'firstRetainedRow', 'lastRetainedRow')):
        raise ValueError('game preparation differs from independent original assessment')
