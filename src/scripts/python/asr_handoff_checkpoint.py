"""Private per-job checkpoint and aligned random-access PCM; never write live caches."""
from contextlib import contextmanager
import hashlib
import json
import math
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
                        '-map', '0:a:0', '-vn', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', '16000',
                        '-f', 'f32le', str(target)], check=True, capture_output=True, timeout=600,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        size = target.stat().st_size
        audio_end = None
        if size > 0 and size % 4 == 0 and round(duration * 16000) - size // 4 > 8000:
            audio_end = probe_audio_end(audio, size / 64000)
        align_pcm_tail(target, duration, audio_end=audio_end)
        yield str(target)


def probe_audio_end(audio, decoded_end):
    """Read the selected track through EOF, starting near the decoded PCM tail."""
    result = subprocess.run([
        'ffprobe', '-v', 'error', '-select_streams', 'a:0',
        '-read_intervals', f'{max(0, decoded_end - 5):.6f}%',
        '-show_packets', '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', str(audio)
    ], check=True, capture_output=True, text=True, timeout=30,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    ends = []
    for packet in json.loads(result.stdout).get('packets', []):
        pts, length = float(packet['pts_time']), float(packet['duration_time'])
        if not math.isfinite(pts) or not math.isfinite(length) or length <= 0:
            raise ValueError('Invalid audio packet tail; checkpoint not advanced')
        ends.append(pts + length)
    if not ends:
        raise ValueError('Missing audio packet tail; checkpoint not advanced')
    return max(ends)


def align_pcm_tail(path, duration, *, audio_end=None):
    """Longer video-only tails require independent evidence that audio reached EOF."""
    size = Path(path).stat().st_size
    missing = round(duration * 16000) - size // 4
    verified = (audio_end is not None and math.isfinite(audio_end) and audio_end > 0
                and abs(audio_end - size / 64000) <= 0.5 and audio_end <= duration + 0.5)
    if not size or size % 4 or missing > 8000 and not verified:
        raise ValueError(f'Aligned audio ended early; checkpoint not advanced '
                         f'(expected={duration:.5f}s, decoded={size / 64000:.5f}s, audio_end={audio_end})')
    if missing > 0:
        from sensevoice_runtime import log_progress
        evidence = f'音频包已到 EOF={audio_end:.5f}s' if missing > 8000 else '上限 0.5s'
        log_progress(f'ASR 对齐容器音频尾差: 补齐 {missing / 16000:.5f}s 静音（{evidence}）')
        with open(path, 'ab') as stream:
            remaining = missing * 4
            while remaining:
                count = min(remaining, 1024 ** 2)
                stream.write(b'\0' * count)
                remaining -= count


def read_pcm(path, start, duration):
    import numpy as np
    frames = round(duration * 16000)
    with open(path, 'rb') as stream:
        stream.seek(round(start * 16000) * 4)
        audio = np.frombuffer(stream.read(frames * 4), dtype='<f4').copy()
    if len(audio) < frames - 3200:
        raise ValueError('Truncated handoff PCM')
    return np.pad(audio, (0, frames - len(audio)))
