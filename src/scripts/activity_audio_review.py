"""Revalidate local activity audio evidence and its DaiYu assessment before upload."""
import json
import hashlib
import math
import re
from pathlib import Path

def closed_context_enclosure(event):
    """Only meaningful after check_local_activity revalidates the bound assessment."""
    verification = event.get('verification') or {}
    return (verification.get('method') == 'independent_local_asr'
            and verification.get('decision') == 'keep'
            and verification.get('boundaryPolicy') == 'complete_context_enclosure')


def unresolved_activity_issues(event):
    informational = {'start_boundary_unconfirmed', 'end_boundary_unconfirmed'} if closed_context_enclosure(event) else set()
    return [issue for issue in event.get('reviewIssues') or [] if issue not in informational]

def file_digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_bound(path, expected):
    if file_digest(path) != expected:
        raise ValueError("local activity evidence changed")
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def check_extraction(path, source, start, end=None):
    receipt = json.loads(Path(str(path) + '.complete.json').read_text(encoding='utf-8-sig'))
    identity = {k: source[k] for k in ('mediaPath', 'mediaBytes', 'mediaMtimeNs')}
    args = (['-y', '-ss', str(start), '-i', source['mediaPath'], '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', path]
            if end is None else ['-y', '-ss', str(start), '-i', source['mediaPath'], '-t', str(end-start),
                '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', path])
    actual = receipt.get('args') or []
    # JS stringifies integral seconds without .0.
    if len(actual) == len(args):
        args[2] = actual[2] if float(actual[2]) == start else args[2]
        if end is not None:
            args[6] = actual[6] if abs(float(actual[6]) - (end-start)) < .001 else args[6]
    signature = hashlib.sha256(json.dumps({'args': actual, 'source': identity}, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()
    if (receipt.get('version') != 3 or receipt.get('source') != identity or actual != args
            or receipt.get('signature') != signature or receipt.get('sha256') != file_digest(path)):
        raise ValueError('local activity extraction is not bound to the original recording')


def check_segmented_listening(listening, native, original_audio, frames, source, candidates):
    segments = listening.get('segments') or {}
    audio = segments.get('audio') or []
    nested = segments.get('listening') or {}
    expected = []
    offsets = {i + 1: row['start'] for i, row in enumerate(original_audio)}
    previous_index = 1
    for row in audio:
        index = row.get('originalAudioIndex')
        if type(index) is not int or index not in offsets or index < previous_index:
            raise ValueError('segmented listening audio identity changed')
        original = original_audio[index - 1]
        if row['start'] != offsets[index] or not row['start'] < row['end'] <= min(row['start'] + 60, original['end']):
            raise ValueError('segmented listening coverage changed')
        check_extraction(row['path'], source, row['start'], row['end'])
        expected.append(dict(path=row['path'], start=row['start'], end=row['end'], sha256=file_digest(row['path'])))
        offsets[index] = row['end']; previous_index = index
    if any(offsets[i + 1] != row['end'] for i, row in enumerate(original_audio)):
        raise ValueError('segmented listening coverage changed')
    expected += [{k: frame[k] for k in ('path', 'sha256', 'time', 'activityId')} for frame in frames]
    if (nested.get('version') != 1 or nested.get('protocolVersion') != 2 or nested.get('source') != source
            or nested.get('inputs') != expected or nested.get('response') != listening['response']
            or nested.get('observations') != native.get('observations')):
        raise ValueError('segmented listening original input changed')
    mapped = []
    for observation in native.get('observations') or []:
        candidate = next((c for c in candidates if c['id'] == observation.get('id')), None)
        if not candidate:
            raise ValueError('segmented listening candidate changed')
        phases = []; seen = set()
        for phase in observation.get('chronology') or []:
            index = phase.get('audioIndex')
            if type(index) is not int or not 1 <= index <= len(audio):
                raise ValueError('segmented listening audio index changed')
            segment = audio[index - 1]
            if (segment['originalAudioIndex'] not in candidate['audioIndices']
                    or any(type(phase.get(k)) not in (int, float) or not math.isfinite(phase[k]) for k in ('start', 'end'))
                    or not 0 <= phase['start'] < phase['end'] <= segment['end'] - segment['start']):
                raise ValueError('segmented listening local time changed')
            offset = segment['start'] - original_audio[segment['originalAudioIndex'] - 1]['start']
            phases.append({**phase, 'audioIndex': segment['originalAudioIndex'], 'start': offset + phase['start'], 'end': offset + phase['end']})
            seen.add(index)
        if any(i + 1 not in seen for i, row in enumerate(audio) if row['originalAudioIndex'] in candidate['audioIndices']):
            raise ValueError('segmented listening omitted original audio')
        mapped.append({**observation, 'chronology': phases})
    return {**native, 'observations': mapped}


def check_local_activity(event, source):
    evidence = event.get('verification') or {}
    if evidence.get('method') != 'independent_local_asr':
        return
    if (evidence.get('decision') != 'keep' or not evidence.get('localAudioEvidence')
            or not evidence.get('responsePath') or not evidence.get('responseSha256')):
        raise ValueError('local activity needs a completed independent assessment')
    bundle = evidence['localAudioEvidence']
    local = read_bound(bundle['resultPath'], bundle['sha256'])
    receipt = read_bound(bundle['receiptPath'], bundle['receiptSha256'])
    if (receipt.get('version') != 1 or receipt.get('sha256') != bundle['sha256']
            or local.get('source') != {k: source[k] for k in ('mediaPath', 'mediaBytes', 'mediaMtimeNs')}
            or local.get('method') != 'independent_local_asr' or local.get('audio') != bundle.get('audio')):
        raise ValueError('local activity decoder provenance changed')
    request_path = Path(bundle['resultPath']).with_name('LOCAL_INPUT.json')
    request = read_bound(request_path, receipt['inputSha256'])
    if request.get('source') != local.get('source') or request.get('settings') != local.get('settings') or len(request['audio']) != len(local['audio']):
        raise ValueError('local activity decoder inputs changed')
    for original, row in zip(request['audio'], local['audio']):
        if any(original.get(k) != row.get(k) for k in ('start', 'end', 'sha256')):
            raise ValueError('local activity audio window changed')
        check_extraction(original['path'], source, row['start'], row['end'])
        if file_digest(original['path']) != row['sha256']:
            raise ValueError('local activity original audio changed')
    response = read_bound(evidence['responsePath'], evidence['responseSha256'])
    binding = response['requestBinding']
    if binding.get('source') != source or binding.get('localAudioSha256') != bundle['sha256'] or binding.get('frames') != evidence['frameEvidence']:
        raise ValueError('local activity assessment input changed')
    if binding.get('nativeListening') != evidence.get('nativeListening'):
        raise ValueError('native listening binding changed')
    if binding.get('nativeListening'):
        reference = binding['nativeListening']
        listening = read_bound(reference['path'], reference['sha256'])
        expected = [{k: original[k] for k in ('path', 'sha256', 'start', 'end')} for original in request['audio']]
        expected += [{k: frame[k] for k in ('path', 'sha256', 'time', 'activityId')} for frame in evidence['frameEvidence']]
        if (listening.get('version') != 1 or listening.get('protocolVersion') not in (2, 3) or listening.get('source') != source or listening.get('inputs') != expected
                or listening.get('response', {}).get('meta', {}).get('apiMode') != 'gemini_native'):
            raise ValueError('native listening original input changed')
        for item in expected:
            if file_digest(item['path']) != item['sha256']:
                raise ValueError('native listening source changed')
        native = json.loads(re.sub(r'\s*```$', '', re.sub(r'^```(?:json)?\s*', '', listening['response']['text'].strip())))
        if listening['protocolVersion'] == 3:
            native = check_segmented_listening(listening, native, request['audio'], evidence['frameEvidence'], source, binding['candidates'])
        if native.get('timeBasis') != 'audio_local_seconds' or native.get('observations') != listening.get('observations'):
            raise ValueError('native listening chronology changed')
        for observation in native['observations']:
            candidate = next((c for c in binding['candidates'] if c['id'] == observation.get('id')), None)
            if not candidate or not observation.get('chronology'):
                raise ValueError('native listening has no candidate chronology')
            for phase in observation['chronology']:
                if type(phase.get('audioIndex')) is not int or phase['audioIndex'] not in candidate['audioIndices']:
                    raise ValueError('native listening references another audio')
                audio = request['audio'][phase['audioIndex']-1]
                if (any(type(phase.get(k)) not in (float, int) or not math.isfinite(phase[k]) for k in ('start', 'end'))
                        or not 0 <= phase['start'] < phase['end'] <= audio['end']-audio['start']):
                    raise ValueError('native listening time is outside original audio')
    for frame in evidence['frameEvidence']:
        check_extraction(frame['path'], source, frame['time'])
        if file_digest(frame['path']) != frame['sha256']:
            raise ValueError('local activity original image changed')
    raw = json.loads(re.sub(r'\s*```$', '', re.sub(r'^```(?:json)?\s*', '', response['text'].strip())))
    candidate = next(c for c in binding['candidates'] if c['id'] == event['id'])
    matches = [r for r in raw['results'] if r['id'] == event['id']]
    if len(matches) != 1 or matches[0]['decision'] != 'keep' or evidence.get('decision') != 'keep':
        raise ValueError('local activity needs a completed independent assessment')
    result = matches[0]
    if (event['kind'] == 'song' and result.get('performer') != 'host' or result.get('startContextClosed') is not True
            or result.get('endContextClosed') is not True or result.get('evidenceRefs') != evidence.get('evidenceRefs')
            or not result.get('evidenceRefs') or result.get('timeBasis') != 'audio_local_seconds' or len(result.get('events') or []) != 1):
        raise ValueError('local activity complete context or ownership changed')
    normalize = lambda s: ''.join(c for c in str(s or '').lower() if c.isalnum())
    if not any(len(normalize(ref.get('quote'))) >= 4 for ref in result['evidenceRefs']):
        raise ValueError('local activity requires substantial independent context')
    for ref in result['evidenceRefs']:
        if ref['audioIndex'] not in candidate['audioIndices']:
            raise ValueError('local activity quote references another candidate')
        audio = local['audio'][ref['audioIndex']-1]
        chunk = audio['chunks'][ref['chunkIndex']-1]
        texts = [chunk['text']] + [r['text'] for r in audio['transcript'] if r['chunkIndex'] == ref['chunkIndex']]
        if len(normalize(ref['quote'])) < 2 or not any(normalize(ref['quote']) in normalize(s) for s in texts):
            raise ValueError('local activity quote is absent from independent audio')
    observed = result['events'][0]
    for key in ('start', 'end'):
        bound = observed[key]
        audio = local['audio'][bound['audioIndex']-1]
        seconds = bound['seconds']
        if (bound['audioIndex'] not in candidate['audioIndices'] or isinstance(seconds, bool) or not isinstance(seconds, (int, float))
                or not math.isfinite(seconds) or not 0 <= seconds <= audio['end']-audio['start']
                or abs(event[key] - audio['start'] - seconds) > .001):
            raise ValueError('local activity boundary differs from independent assessment')
    revised_start = candidate['start']
    revision = result.get('preludeCorrection')
    if revision:
        ref = revision.get('announcement') or {}
        preview_restart = revision.get('version') == 3 and revision.get('method') == 'preview_then_complete_restart'
        restart = preview_restart or revision.get('version') == 2 and revision.get('method') == 'playback_then_restarted_performance'
        if preview_restart and (candidate.get('allowPreviewRestart') is not True or revision.get('noUniqueVerseLost') is not True
                or revision.get('preludeKind') != 'listening_or_rehearsal' or not binding.get('nativeListening')):
            raise ValueError('complete preview restart must preserve every unique verse with native evidence')
        if (event['kind'] != 'song' or not restart and (revision.get('version') != 1 or revision.get('method') != 'separate_preview_before_performance')
                or revision.get('previewContextClosed') is not True or revision.get('formalPerformanceComplete') is not True
                or revision.get('preludeKind') not in ('playback', 'listening_or_rehearsal') or not str(revision.get('reason') or '').strip()
                or revision != evidence.get('preludeCorrection') or ref.get('audioIndex') not in candidate['audioIndices']
                or not isinstance(ref.get('chunkIndex'), int) or ref['chunkIndex'] < 1):
            raise ValueError('song prelude correction needs independent closed context')
        audio = local['audio'][ref['audioIndex']-1]
        chunk = audio['chunks'][ref['chunkIndex']-1]
        texts = [chunk['text']] + [r['text'] for r in audio['transcript'] if r['chunkIndex'] == ref['chunkIndex']]
        revised_start = audio['start'] + chunk['start']
        if (len(normalize(ref.get('quote'))) < 4 or not any(normalize(ref['quote']) in normalize(t) for t in texts)
                or not re.search(r'歌|唱|song|sing' if restart else r'开始唱|请听|now.{0,12}sing|will.{0,12}sing|lets.{0,12}sing', normalize(ref['quote']))
                or not candidate['start'] < revised_start < candidate['end'] or audio['start'] > candidate['start']
                or audio['end'] < revised_start or observed['start'] != {'audioIndex': ref['audioIndex'], 'seconds': chunk['start']}):
            raise ValueError('song prelude correction must retain the original performance announcement chunk')
        if restart:
            openings = []
            for key in ('openingBefore', 'openingAfter'):
                item = revision.get(key) or {}
                if (type(item.get('audioIndex')) is not int or type(item.get('chunkIndex')) is not int
                        or item['audioIndex'] not in candidate['audioIndices'] or item['chunkIndex'] < 1):
                    raise ValueError('song restart has invalid opening references')
                a = local['audio'][item['audioIndex']-1]
                c = a['chunks'][item['chunkIndex']-1]
                words = [c['text']] + [t['text'] for t in a['transcript'] if t['chunkIndex'] == item['chunkIndex']]
                quote = normalize(item.get('quote'))
                if len(quote) < 6 or not any(quote in normalize(t) for t in words):
                    raise ValueError('song restart needs independently repeated opening lyrics')
                openings.append((a['start']+c['start'], a['start']+c['end'], quote))
            if (not preview_restart and (revision.get('preludeKind') != 'playback' or revision.get('priorPlaybackConfirmed') is not True)
                    or revision.get('openingRestartConfirmed') is not True or openings[0][2] != openings[1][2]
                    or openings[0][0] < candidate['start'] or openings[0][1] > revised_start
                    or openings[1][0] < audio['start']+chunk['end'] or openings[1][1] > candidate['end']
                    or audio['end'] < candidate['end']):
                raise ValueError('song restart must separate complete playback, selection and a new opening')
        images = sorted((f for f in evidence['frameEvidence'] if f['activityId'] == event['id']
            and candidate['start'] <= f['time'] <= revised_start), key=lambda f: f['time'])
        if (not images or images[0]['time'] > candidate['start']+30 or images[-1]['time'] < revised_start-30
                or any(b['time']-a['time'] > 60 for a,b in zip(images,images[1:]))):
            raise ValueError('song prelude correction lacks complete original image coverage')
    elif evidence.get('preludeCorrection'):
        raise ValueError('song prelude correction is absent from the bound assessment')
    if event['start'] > revised_start + .5 or event['end'] < candidate['end'] - .5:
        raise ValueError('local activity enclosure would omit observed performance')
