"""Versioned, resumable CPU transcription checkpoints. No publication or queues."""
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import time


def cache_path(source):
    return Path(source).with_suffix('.live-asr.json')


def source_identity(source):
    stat = os.stat(source)
    if stat.st_size < 131072:
        raise ValueError('Recording too small for a stable media fingerprint')
    with open(source, 'rb') as handle:
        handle.seek(65536)  # FLV headers can be rewritten when the recorder closes.
        digest = hashlib.sha256(handle.read(65536)).hexdigest()
    return {'sample_hash': digest, 'size': stat.st_size,
            'birth_ms': round(getattr(stat, 'st_birthtime', stat.st_ctime) * 1000)}


def same_source(expected, actual):
    return (expected.get('sample_hash') == actual.get('sample_hash')
            and expected.get('birth_ms') == actual.get('birth_ms') and actual['size'] >= expected['size'])


def model_spec(payload):
    return {'audio_timeline': 'media_pts_v1', **{key: payload.get(key, default) for key, default in {
        'model': 'paraformer-zh', 'vad_model': 'fsmn-vad', 'punc_model': 'ct-punc',
        'language': 'auto', 'use_itn': True,
        'vad_kwargs': {'max_single_segment_time': 60000, 'chunk_size': 60000},
    }.items()}}


def atomic_json(file, value):
    temporary = str(file) + f'.{os.getpid()}.tmp'
    Path(temporary).write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    os.replace(temporary, file)


def probe_duration(source):
    result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                             '-of', 'default=nw=1:nk=1', str(source)],
                            capture_output=True, text=True, timeout=20,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), check=True)
    value = float(result.stdout.strip())
    if not math.isfinite(value) or value <= 0:
        raise ValueError('Invalid media duration')
    return value


def decode_window(source, start, duration):
    import numpy as np
    result = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-threads', '1',
                             '-ss', str(start), '-i', str(source), '-t', str(duration),
                             '-vn', '-af', 'aresample=async=1:first_pts=0',
                             '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'],
                            capture_output=True, timeout=45,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), check=True)
    audio = np.frombuffer(result.stdout, dtype='<f4').copy()
    expected = round(duration * 16000)
    if len(audio) < expected - 3200:
        raise ValueError('Audio extraction ended early; checkpoint not advanced')
    if len(audio) < expected:
        audio = np.pad(audio, (0, expected - len(audio)))  # Container/audio tail can differ by a fraction of a frame.
    else:
        audio = audio[:expected]
    return audio


def commit_boundary(intervals, duration, final=False, minimum=15, silence=0.6, maximum=120):
    """Commit only a VAD end followed by observed silence; retain unfinished speech."""
    if final:
        return duration
    if not intervals:
        return duration  # Observed silence is covered, even without subtitle rows.
    candidates = [float(end) / 1000 for _, end in intervals
                  if minimum <= float(end) / 1000 <= duration - silence]
    if candidates:
        return max(candidates)
    return duration if duration >= maximum - 0.05 else None


def validate_chunks(chunks, duration=None):
    previous = 0.0
    for chunk in chunks:
        start, end = float(chunk['start']), float(chunk['end'])
        if not all(math.isfinite(x) for x in (start, end)) or start < previous - 0.01 or end <= start:
            raise ValueError('Invalid or overlapping live ASR checkpoint')
        if duration is not None and end > duration + 0.25:
            raise ValueError('Checkpoint exceeds media duration')
        result = chunk['result']
        if not isinstance(result, dict) or not isinstance(result.get('text', ''), str):
            raise ValueError('Invalid transcription result')
        for row in result.get('timestamp', []):
            if len(row) != 2 or not all(math.isfinite(float(x)) for x in row) or not 0 <= row[0] <= row[1] <= (end - start) * 1000 + 250:
                raise ValueError('Timestamp outside checkpoint window')
        for row in result.get('sentence_info') or []:
            a, b = float(row['start']), float(row['end'])
            if not math.isfinite(a) or not math.isfinite(b) or not 0 <= a <= b <= (end - start) * 1000 + 250:
                raise ValueError('Sentence outside checkpoint window')
        previous = end


def missing_ranges(chunks, duration):
    validate_chunks(chunks, duration)
    cursor, gaps = 0.0, []
    for chunk in chunks:
        if chunk['start'] > cursor + 0.01:
            gaps.append((cursor, chunk['start']))
        cursor = chunk['end']
    if cursor < duration - 0.05:
        gaps.append((cursor, duration))
    return gaps


def aggregate_chunks(chunks):
    """FunASR timestamps are milliseconds within each non-overlapping audio window."""
    validate_chunks(chunks)
    result = {'text': '', 'timestamp': [], 'sentence_info': []}
    for chunk in chunks:
        value, offset = chunk['result'], chunk['start'] * 1000
        result['text'] += (' ' if result['text'] else '') + value.get('text', '')
        result['timestamp'].extend([[round(a + offset, 3), round(b + offset, 3)]
                                    for a, b in value.get('timestamp', [])])
        sentences = value.get('sentence_info') or []
        if not sentences and value.get('text', '').strip():
            from paraformer_segments import paraformer_full_text_to_segments
            sentences = [{'text': s['text'], 'start': s['start'] * 1000, 'end': s['end'] * 1000}
                         for s in paraformer_full_text_to_segments(value)]
            if not sentences:
                raise ValueError('Live ASR text lacks usable timestamps')
        for sentence in sentences:
            result['sentence_info'].append({**sentence, 'start': sentence['start'] + offset,
                                            'end': sentence['end'] + offset,
                                            'timestamp': [[a + offset, b + offset] for a, b in sentence.get('timestamp', [])]})
    return [result]


class CpuLiveTranscriber:
    """One CPU-only model, shared by all requests in a single worker."""
    def __init__(self, payload):
        import torch
        from funasr import AutoModel
        from sensevoice_runtime import prepare_asr_runtime
        from sensevoice_text import resolve_cached_model_name
        self.payload = payload
        self.guard = prepare_asr_runtime({'resource_guard': {'enabled': bool(payload.get('_live_worker')), 'claim_enabled': False,
            'priority': 'belowNormal', 'eco_qos': True, 'prefer_e_cores': True,
            'torch_num_threads': 2, 'torch_num_interop_threads': 1}})
        spec = model_spec(payload)
        kwargs = {**{k: v for k, v in spec.items() if k != 'audio_timeline'},
                  'device': 'cpu', 'ncpu': 2, 'disable_update': True, 'disable_pbar': True}
        for key in ('model', 'vad_model', 'punc_model'):
            if kwargs[key]:
                kwargs[key] = resolve_cached_model_name(kwargs[key])
        kwargs['vad_kwargs'] = {**kwargs['vad_kwargs'], 'ncpu': 2}
        self.model = AutoModel(**kwargs)
        if any(str(parameter.device) != 'cpu' for parameter in self.model.model.parameters()):
            raise RuntimeError('CPU live ASR model must remain on CPU')

    def window(self, source, start, duration, final=False):
        import torch
        from asr_window_result import vad_intervals
        from asr_vad_reuse import generate_with_vad
        audio = decode_window(source, start, duration)
        actual = len(audio) / 16000
        with torch.inference_mode():
            vad = self.model.inference(audio, model=self.model.vad_model,
                kwargs={**self.model.vad_kwargs}, disable_pbar=True)
            intervals = vad_intervals(vad, actual)
            end = commit_boundary(intervals, actual, final)
            if end is None:
                return None
            frames = min(len(audio), round(end * 16000))
            result = generate_with_vad(self.model, audio[:frames], vad, cache={}, batch_size_s=30,
                batch_size_threshold_s=30, sentence_timestamp=True, disable_pbar=True,
                language=self.payload.get('language', 'auto'), use_itn=self.payload.get('use_itn', True))
        chunk = {'start': start, 'end': round(start + frames / 16000, 5),
                 'result': result}
        validate_chunks([chunk])
        aggregate_chunks([chunk])  # Refuse text with unusable time alignment before committing.
        return chunk


def read_cache(source, payload, room_id):
    value = json.loads(cache_path(source).read_text(encoding='utf-8'))
    if value.get('version') != 1 or value.get('room_id') != str(room_id) or value.get('spec') != model_spec(payload):
        raise ValueError('Live ASR model/room/version mismatch')
    if not same_source(value['source'], source_identity(source)):
        raise ValueError('Live ASR source fingerprint mismatch')
    validate_chunks(value['chunks'])
    return value


def finish_cached_transcript(payload, audio_path, infer_factory=CpuLiveTranscriber, probe=probe_duration):
    """Only reuse an opted-in room's validated media; fill missing audio, never retouch cached words."""
    live = payload.get('live_asr') or {}
    room = str(payload.get('room_id') or '')
    if live.get('enabled') is not True or room not in list(map(str, live.get('room_ids') or [])):
        return None
    source = live.get('source_path') or audio_path
    if not cache_path(source).is_file():
        return None
    from sensevoice_runtime import log_progress, set_timing
    try:
        value = read_cache(source, payload, room)
        if not value['chunks']:
            return None
        duration = probe(audio_path)
        source_duration = probe(source) if os.path.abspath(source) != os.path.abspath(audio_path) else duration
        if abs(source_duration - duration) > 0.25:
            raise ValueError('Processed audio timeline differs from live recording')
        gaps = missing_ranges(value['chunks'], duration)
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as exc:
        log_progress(f'实时 ASR 缓存不可复用，回退原流程: {exc}')
        return None
    started = time.perf_counter()
    chunks = list(value['chunks'])
    reused = sum(c['end'] - c['start'] for c in chunks)
    if gaps:
        infer = infer_factory(payload)
        for start, end in gaps:
            while end - start > 0.05:
                size = min(120, end - start)
                chunk = infer.window(audio_path, start, size, final=True)
                if chunk is None or chunk['end'] <= start:
                    raise RuntimeError('Missing audio could not be completed')
                chunks.append(chunk)
                start = chunk['end']
        del infer
    chunks.sort(key=lambda c: c['start'])
    if missing_ranges(chunks, duration):
        raise RuntimeError('Live ASR completion still has uncovered audio')
    set_timing(payload, 'live_asr_reused_audio_s', reused)
    set_timing(payload, 'live_asr_missing_audio_s', max(0, duration - reused))
    set_timing(payload, 'live_asr_completion_s', time.perf_counter() - started)
    log_progress(f'复用直播转写 {reused:.1f}s，仅补齐 {max(0, duration-reused):.1f}s 音频')
    return aggregate_chunks(chunks)
