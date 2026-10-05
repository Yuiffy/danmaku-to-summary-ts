"""Bounded VAD + unprompted Nano + aligned-only hotword hypotheses. No source writes."""
import contextlib
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from topic_audio_policy import decode_window


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


@contextlib.contextmanager
def exclusive_probe():
    """OS releases the lock if timeout kills this process; no stale lock deletion."""
    with open(Path(tempfile.gettempdir()) / 'danmaku-topic-audio.lock', 'a+b') as handle:
        handle.seek(0)
        if os.name == 'nt':
            import msvcrt
            if not handle.read(1):
                handle.write(b'0'); handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            if os.name == 'nt':
                handle.seek(0); msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def check_source(source):
    stat = Path(source['mediaPath']).stat()
    if (stat.st_size != source['mediaBytes'] or abs(stat.st_mtime_ns/1e6-source['mediaMtimeMs']) > .01
            or digest(source['srtPath']) != source['srtSha256']):
        raise ValueError('source changed before/during local audio check')


def cached_model(name):
    from sensevoice_text import resolve_cached_model_name
    resolved = Path(resolve_cached_model_name(name))
    if resolved.is_dir():
        return str(resolved)
    local = Path.home() / '.cache/modelscope/hub/models' / name
    if local.is_dir():
        return str(local)
    raise ValueError(f'local review model is not cached: {name}')


def analyze(request, output):
    from sensevoice_runtime import prepare_asr_runtime, GpuThrottle, _resource_claim_file
    settings = request['settings']
    windows = request['windows']
    if request.get('version') != 1 or not 1 <= len(windows) <= 4:
        raise ValueError('invalid topic audio batch')
    if any(not 0 <= w['start'] < w['end'] or w['end']-w['start'] > 30 for w in windows):
        raise ValueError('invalid topic audio interval')
    if sum(w['end']-w['start'] for w in windows) > 120 or not 1 <= len(settings['hotwords']) <= 8:
        raise ValueError('topic audio budget exceeded')
    check_source(request['source'])
    # Do not overwrite a live full-transcription lease. The normal runtime still
    # applies configured game protection, process priority and GPU backoff.
    claim = Path(_resource_claim_file(settings))
    if claim.exists() and time.time()-claim.stat().st_mtime < 15:
        raise RuntimeError('another ASR resource lease is active')
    guard = prepare_asr_runtime(settings)
    try:
        import numpy as np
        import soundfile as sf
        import torch
        from funasr import AutoModel
        device = settings.get('device', 'cuda')
        throttle = GpuThrottle(settings, device)
        throttle.wait_if_busy('topic VAD model')
        vad_model = AutoModel(model=cached_model(settings['vadModel']), device='cpu', ncpu=2,
                              disable_update=True, disable_pbar=True, trust_remote_code=False)
        nano = None

        def vad(samples):
            raw = vad_model.generate(input=samples, cache={}, disable_pbar=True)
            return [[a/1000, b/1000] for a, b in raw[0].get('value', [])]

        def decode(samples, names):
            nonlocal nano
            throttle.wait_if_busy('topic audio decode')
            if nano is None:
                nano = AutoModel(model=cached_model(settings['model']), device=device, ncpu=2,
                                 disable_update=True, disable_pbar=True, trust_remote_code=False)
            # Neither source subtitles nor corrections enter this call. No ITN,
            # no phoneme replacements, no source-derived initial prompt.
            return nano.generate(input=torch.from_numpy(samples), cache={}, batch_size=1, language='中文',
                                 hotwords=names, use_itn=False, itn=False, max_length=256,
                                 llm_kwargs={'do_sample': False}, disable_pbar=True)[0]

        rows = []
        for window in windows:
            wav = output.with_name(output.stem + '-' + window['id'] + '.wav')
            subprocess.run([settings['ffmpeg'], '-nostdin', '-hide_banner', '-loglevel', 'error',
                            '-threads', str(settings.get('ffmpegThreads', 2)), '-ss', str(window['start']),
                            '-i', request['source']['mediaPath'], '-t', str(window['end']-window['start']),
                            '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', str(wav)],
                           check=True, timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            samples, rate = sf.read(wav, dtype='float32')
            if samples.ndim != 1 or rate != 16000 or abs(len(samples)/rate-window['end']+window['start']) > .1:
                raise ValueError('extracted audio duration/format differs from request')
            row = decode_window(window, np.asarray(samples), vad, decode, settings['hotwords'])
            row.update(audioPath=str(wav.resolve()), audioSha256=digest(wav), duration=len(samples)/rate)
            rows.append(row)
        check_source(request['source'])
        return {'version': 1, 'method': 'topic_audio_pair', 'requestSha256': request['requestSha256'],
                'source': request['source'], 'settings': settings, 'windows': rows,
                'versions': {name: importlib.metadata.version(name) for name in ('funasr', 'torch')},
                'models': {'asr': settings['model'], 'vad': settings['vadModel']}}
    finally:
        guard.close_claim()


def main():
    request = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
    output = Path(sys.argv[2]).resolve()
    with exclusive_probe():
        result = analyze(request, output)
        temp = output.with_suffix('.tmp')
        temp.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        temp.replace(output)


if __name__ == '__main__':
    main()
