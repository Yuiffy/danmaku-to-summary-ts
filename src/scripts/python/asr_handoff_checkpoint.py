"""Private per-job checkpoint and aligned random-access PCM; never write live caches."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from live_asr_cache import (atomic_json, cache_path, model_spec, read_cache,
                            source_identity, validate_chunks)


def audio_identity(path):
    size = os.path.getsize(path)
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for position in (0, max(0, size // 2 - 32768), max(0, size - 65536)):
            stream.seek(position)
            digest.update(stream.read(65536))
    return {'size': size, 'sample_hash': digest.hexdigest()}


def final_source_identity(path):
    stat = os.stat(path)
    if stat.st_size >= 131072:
        return source_identity(path)
    # The final recording is immutable; tiny WAVs need no reserved FLV header.
    return {**audio_identity(path),
            'birth_ms': round(getattr(stat, 'st_birthtime', stat.st_ctime) * 1000)}


class Checkpoint:
    def __init__(self, payload, duration, probe):
        audio = payload['audio_path']
        source = (payload.get('live_asr') or {}).get('source_path') or audio
        self.path = Path(source).with_suffix('.asr-handoff.json')
        # The final source must be stable (unlike the append-only live cache).
        self.expected = {'version': 1, 'source': final_source_identity(source),
                         'audio': audio_identity(audio), 'duration': duration,
                         'spec': model_spec(payload), 'room_id': str(payload.get('room_id') or '')}
        self.chunks = []
        self.reused_s = 0
        if self.path.exists():
            value = json.loads(self.path.read_text(encoding='utf-8'))
            if {k: value.get(k) for k in self.expected} != self.expected:
                raise ValueError('ASR handoff checkpoint source/model mismatch; preserve or remove the stale sidecar')
            self.chunks = value['chunks']
            validate_chunks(self.chunks, duration)
        else:
            live = payload.get('live_asr') or {}
            room = str(payload.get('room_id') or '')
            if (live.get('enabled') is True and room in list(map(str, live.get('room_ids') or []))
                    and cache_path(source).exists()):
                try:
                    value = read_cache(source, payload, room)
                    if abs(probe(source) - duration) > 0.25:
                        raise ValueError('Live cache audio timeline differs')
                    validate_chunks(value['chunks'], duration)
                    self.chunks = list(value['chunks'])
                except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
                    from sensevoice_runtime import log_progress
                    log_progress(f'接力不复用不匹配的直播缓存: {exc}')
        self.reused_s = sum(c['end'] - c['start'] for c in self.chunks)

    def commit(self, chunk):
        pieces = sorted([*self.chunks, chunk], key=lambda c: c['start'])
        validate_chunks(pieces, self.expected['duration'])
        atomic_json(self.path, {**self.expected, 'chunks': pieces})
        self.chunks = pieces

    def assert_source_unchanged(self, payload):
        source = (payload.get('live_asr') or {}).get('source_path') or payload['audio_path']
        if final_source_identity(source) != self.expected['source'] or audio_identity(payload['audio_path']) != self.expected['audio']:
            raise ValueError('Recording changed during ASR; checkpoint retained, refusing final output')


@contextmanager
def checkpoint_lock(path):
    """OS releases this exclusive byte lock on crash; no stale PID deletion."""
    with open(str(path) + '.lock', 'a+b') as stream:
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            if os.name == 'nt':
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


@contextmanager
def aligned_pcm(audio, duration):
    # Decode once: repeatedly seeking a long FLV can become quadratic and time out.
    parent = str(Path(audio).resolve().parent)
    if shutil.disk_usage(parent).free < duration * 64000 + 256 * 1024 ** 2:
        raise OSError('Insufficient temporary disk space for aligned ASR PCM')
    with tempfile.TemporaryDirectory(prefix='.asr-pcm-', dir=parent) as directory:
        target = Path(directory) / 'audio.f32'
        subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-threads', '1', '-i', str(audio),
                        '-vn', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', '16000',
                        '-f', 'f32le', str(target)], check=True, capture_output=True, timeout=600,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if target.stat().st_size < round(duration * 16000) * 4 - 12800:
            raise ValueError('Aligned audio ended early; checkpoint not advanced')
        yield str(target)


def read_pcm(path, start, duration):
    import numpy as np
    frames = round(duration * 16000)
    with open(path, 'rb') as stream:
        stream.seek(round(start * 16000) * 4)
        audio = np.frombuffer(stream.read(frames * 4), dtype='<f4').copy()
    if len(audio) < frames - 3200:
        raise ValueError('Truncated handoff PCM')
    return np.pad(audio, (0, frames - len(audio)))
