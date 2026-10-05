"""Source-timing and rebuilt-media checks; no ASR, state edits or publication IO."""
import hashlib
import json
import re
from pathlib import Path


def digest(file):
    value = hashlib.sha256()
    with Path(file).open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def source_timing_metadata(srt_path):
    original = re.sub(r'\.speaker\.srt$', '.srt', srt_path, flags=re.IGNORECASE)
    file = Path(original).with_suffix('.asr_meta.json')
    if not file.is_file():
        return {}
    metadata = json.loads(file.read_text(encoding='utf-8-sig'))
    if metadata.get('backend') == 'paraformer' and 'sentence_info_fallback' in str((metadata.get('speakerProcessing') or {}).get('intervalSource') or ''):
        raise ValueError('原字幕时间轴不可靠，需校准后重建视频')
    return {'asrMetaPath': str(file.resolve()), 'asrMetaSha256': digest(file)}


def validate_rendered_timing_repair(metadata):
    repair = metadata.get('renderedTimingRepair')
    if not repair:
        return
    rendered, transcript = repair.get('rendered') or {}, repair.get('transcript') or {}
    output, window = metadata.get('output') or {}, metadata.get('window') or {}
    if (repair.get('version') != 1 or metadata.get('rebuildRequired') or not rendered or not transcript
            or rendered.get('window') != {key: window.get(key) for key in ('start', 'end')}
            or rendered.get('video') != digest(output['mediaPath']) or rendered.get('subtitles') != digest(output['srtPath'])
            or Path(metadata['source']['srtPath']).resolve() != Path(transcript['path']).resolve()
            or transcript.get('mode') != 'repaired_source_audio'
            or any(transcript.get(hash_key) != digest(transcript[path_key]) for path_key, hash_key in (
                ('path', 'sha256'), ('originalSrtPath', 'originalSrtSha256'), ('metadataPath', 'metadataSha256'),
                ('evidencePath', 'evidenceSha256'), ('speakerPath', 'speakerSha256')))):
        raise ValueError('时间轴修复尚未重建，或修复证据已变更')
    original = repair['originalSource']
    media = Path(metadata['source']['mediaPath']).resolve()
    stat = media.stat()
    if (Path(original['mediaPath']).resolve() != media or str(stat.st_size) != original['mediaBytes']
            or str(stat.st_mtime_ns) != original['mediaMtimeNs']):
        raise ValueError('时间轴修复的原录播已变更')
    audio = repair.get('finalAudio') or {}
    final_stat = Path(output['mediaPath']).stat()
    source = audio.get('source') or {}
    if (audio.get('version') != 1 or audio.get('method') != 'unprompted_final_audio'
            or source.get('mediaPath') != str(Path(output['mediaPath']).resolve()) or source.get('mediaBytes') != final_stat.st_size
            or abs(source.get('mediaMtimeMs', -1) - final_stat.st_mtime_ns / 1e6) > .01
            or source.get('srtPath') != str(Path(output['srtPath']).resolve()) or source.get('srtSha256') != rendered['subtitles']
            or digest(audio['requestPath']) != audio.get('requestSha256') or digest(audio['evidencePath']) != audio.get('evidenceSha256')):
        raise ValueError('时间轴修复缺少新成片的独立原音复核')
    read = lambda file: json.loads(Path(file).read_text(encoding='utf-8-sig'))
    request, result = read(audio['requestPath']), read(audio['evidencePath'])
    if (result.get('requestSha256') != request.get('requestSha256') or result.get('source') != source
            or result.get('windows') != audio.get('windows') or not audio.get('windows')
            or any(digest(row['audioPath']) != row.get('audioSha256') or len(row.get('decodes') or []) != 2
                   or len({decode.get('model') for decode in row['decodes']}) != 2
                   or any(decode.get('prompted') is not False or decode.get('hotwords') or decode.get('useItn') is not False
                          for decode in row['decodes']) for row in audio['windows'])):
        raise ValueError('新成片的独立原音证据已变更')
    return hashlib.sha256((audio['requestSha256'] + '\0' + audio['evidenceSha256']).encode()).hexdigest()
