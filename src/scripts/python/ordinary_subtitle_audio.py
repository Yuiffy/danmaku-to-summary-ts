"""Bounded independent, unprompted Nano/SenseVoice evidence for ordinary subtitle repair."""
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from topic_audio_checks import cached_model, check_source, digest, exclusive_probe


def validate_request(request):
    windows, settings = request.get('windows'), request.get('settings') or {}
    if request.get('version') != 1 or not isinstance(windows, list) or not 1 <= len(windows) <= 4:
        raise ValueError('ordinary subtitle audio requires 1-4 windows')
    if any(not isinstance(row, dict) or not re.fullmatch(r'A[1-4]', str(row.get('id', '')))
           or any(isinstance(row.get(key), bool) or not isinstance(row.get(key), (int, float))
                  or not math.isfinite(row[key]) for key in ('start', 'end'))
           or not 0 <= row['start'] < row['end'] or row['end'] - row['start'] > 30 for row in windows):
        raise ValueError('ordinary subtitle audio window exceeds 30 seconds')
    if sum(row['end'] - row['start'] for row in windows) > 120 or len({row['id'] for row in windows}) != len(windows):
        raise ValueError('ordinary subtitle audio budget or window identity invalid')
    if settings.get('hotwords') or settings.get('initial_prompt') or settings.get('prompt') or settings.get('use_itn') is not False:
        raise ValueError('ordinary subtitle audio cannot receive words, prompts or ITN')
    if not settings.get('model') or not settings.get('sensevoiceModel') or settings['model'] == settings['sensevoiceModel']:
        raise ValueError('two independent local models are required')


def decode_speech_blocks(samples, intervals, infer, rate=16000):
    """Decode all speech after pauses; neither model receives the source subtitle text."""
    blocks = []
    duration_ms = len(samples) * 1000 / rate
    for interval in intervals:
        if (not isinstance(interval, (list, tuple)) or len(interval) != 2
                or any(isinstance(value, bool) or not isinstance(value, (int, float))
                       or not math.isfinite(value) for value in interval)
                or not 0 <= interval[0] < interval[1] <= duration_ms + 1):
            raise ValueError('ordinary subtitle speech interval differs from audio')
        start = max(0, math.floor((interval[0] - 200) * rate / 1000))
        end = min(len(samples), math.ceil((interval[1] + 200) * rate / 1000))
        if blocks and start < blocks[-1][0]:
            raise ValueError('ordinary subtitle speech intervals are out of order')
        if blocks and start <= blocks[-1][1]:
            blocks[-1][1] = max(blocks[-1][1], end)
        else:
            blocks.append([start, end])
    decoded = []
    for start, end in blocks:
        results = infer(samples[start:end])
        if not isinstance(results, list) or len(results) != 1 or not isinstance(results[0].get('text'), str):
            raise ValueError('ordinary subtitle speech decode is incomplete')
        text = re.sub(r'<\|[^|]+\|>', '', results[0]['text']).strip()
        decoded.append({'start': start / rate, 'end': end / rate, 'text': text})
    return decoded


def analyze(request, output):
    validate_request(request)
    from sensevoice_runtime import prepare_asr_runtime, GpuThrottle, _resource_claim_file
    settings = request['settings']
    check_source(request['source'])
    claim = Path(_resource_claim_file(settings))
    if claim.exists() and time.time() - claim.stat().st_mtime < 15:
        raise RuntimeError('another ASR resource lease is active')
    guard = prepare_asr_runtime(settings)
    try:
        import gc
        import numpy as np
        import soundfile as sf
        import torch
        from funasr import AutoModel
        if cached_model(settings['model']) == cached_model(settings['sensevoiceModel']):
            raise ValueError('two independent model paths are required')
        device = settings.get('device', 'cuda')
        throttle = GpuThrottle(settings, device)
        vad = AutoModel(model=cached_model(settings['vadModel']), device='cpu', ncpu=2,
                        disable_update=True, disable_pbar=True, trust_remote_code=False)
        rows, samples_by_id = [], {}
        for window in request['windows']:
            wav = output.with_name(window['id'] + '.wav')
            subprocess.run([settings.get('ffmpeg', 'ffmpeg'), '-nostdin', '-hide_banner', '-loglevel', 'error',
                            '-threads', str(settings.get('ffmpegThreads', 2)), '-ss', str(window['start']),
                            '-i', request['source']['mediaPath'], '-t', str(window['end'] - window['start']),
                            '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', str(wav)],
                           check=True, timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            samples, rate = sf.read(wav, dtype='float32')
            if samples.ndim != 1 or rate != 16000 or abs(len(samples) / rate - window['end'] + window['start']) > .1:
                raise ValueError('ordinary subtitle audio duration/format differs')
            intervals = vad.generate(input=samples, cache={}, disable_pbar=True)[0].get('value', [])
            samples_by_id[window['id']] = np.asarray(samples)
            rows.append({**window, 'audioPath': str(wav.resolve()), 'audioSha256': digest(wav),
                         'duration': len(samples) / rate, 'vad': intervals, 'decodes': []})
        for model_name, language in [(settings['model'], '中文'), (settings['sensevoiceModel'], 'auto')]:
            throttle.wait_if_busy('ordinary subtitle audio model')
            model = AutoModel(model=cached_model(model_name), device=device, ncpu=2,
                              disable_update=True, disable_pbar=True, trust_remote_code=False)
            for row in rows:
                if not row['vad']:
                    continue
                throttle.wait_if_busy('ordinary subtitle audio decode')
                def infer(chunk):
                    throttle.wait_if_busy('ordinary subtitle audio speech block')
                    return model.generate(input=torch.from_numpy(chunk), cache={}, batch_size=1,
                                          language=language, hotwords=[], use_itn=False, itn=False,
                                          max_length=512, llm_kwargs={'do_sample': False}, disable_pbar=True)
                decoded = decode_speech_blocks(samples_by_id[row['id']], row['vad'], infer)
                text = ''.join(block['text'] for block in decoded)
                row['decodes'].append({'model': model_name, 'text': text, 'prompted': False,
                                       'hotwords': [], 'useItn': False, 'timingPrecision': 'window',
                                       'speechBlocks': decoded})
            del model
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        check_source(request['source'])
        return {'version': 1, 'requestSha256': request['requestSha256'], 'source': request['source'], 'windows': rows,
                'versions': {name: importlib.metadata.version(name) for name in ('funasr', 'torch')}}
    finally:
        guard.close_claim()


if __name__ == '__main__':
    request_path, output_path = map(Path, sys.argv[1:3])
    request_data = json.loads(request_path.read_text(encoding='utf-8-sig'))
    with exclusive_probe():
        result = analyze(request_data, output_path)
    temporary = output_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(output_path)
