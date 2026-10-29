"""Private JSON-lines CPU inference adapter; lifecycle belongs to LiveAsrRunner."""
import contextlib
import json
import os
from pathlib import Path
import sys
import time
import traceback

os.environ.update(CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='2', MKL_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2')


def update(request, models):
    from live_asr_cache import (CpuLiveTranscriber, aggregate_chunks, atomic_json, cache_path,
                               model_spec, probe_duration, read_cache, source_identity)
    from paraformer_segments import paraformer_full_text_to_segments
    source, room, payload = request['source'], str(request['room_id']), {**request['options'], '_live_worker': True}
    target = cache_path(source)
    if target.exists():
        value = read_cache(source, payload, room)  # A conflicting cache is never overwritten.
    else:
        value = {'version': 1, 'room_id': room, 'spec': model_spec(payload),
                 'source': source_identity(source), 'chunks': []}
    cursor = value['chunks'][-1]['end'] if value['chunks'] else 0
    duration = probe_duration(source)
    safe_end = max(0, duration - 3)  # Never decode the recorder's partially written tail.
    size = min(float(request.get('window_s', 60)), safe_end - cursor)
    if size < 15 or size < 59 and safe_end - cursor < 59:
        return {'cursor': cursor, 'duration': duration, 'waiting': True}
    key = json.dumps(model_spec(payload), sort_keys=True)
    if key not in models:
        models.clear()
        models[key] = CpuLiveTranscriber(payload)
    began = time.perf_counter()
    chunk = models[key].window(source, cursor, size)
    if chunk is None:
        return {'cursor': cursor, 'duration': duration, 'waiting': True, 'extend': True}
    value['chunks'].append(chunk)
    value['source'] = source_identity(source)
    value['updated_at'] = time.time()
    atomic_json(target, value)
    result = aggregate_chunks(value['chunks'])[0]
    segments = paraformer_full_text_to_segments(result) or [
        {'start': row['start'] / 1000, 'end': row['end'] / 1000, 'text': row['text']}
        for row in result['sentence_info'] if row.get('text', '').strip()]
    def stamp(seconds):
        ms = round(seconds * 1000)
        return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'
    srt = '\n\n'.join(f'{i+1}\n{stamp(s["start"])} --> {stamp(s["end"])}\n{s["text"]}'
                       for i, s in enumerate(segments)) + '\n'
    preview = Path(source).with_suffix('.live.srt')
    temporary = str(preview) + f'.{os.getpid()}.tmp'
    Path(temporary).write_text(srt, encoding='utf-8')
    os.replace(temporary, preview)
    import torch
    if torch.cuda.is_initialized():
        raise RuntimeError('CPU worker initialized CUDA')
    return {'cursor': chunk['end'], 'duration': duration, 'elapsed_s': time.perf_counter()-began,
            'segments': len(segments), 'cuda_initialized': False}


def main():
    models = {}
    output = sys.stdout
    for line in sys.stdin:
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                result = update(request, models)
            reply = {'ok': True, **result}
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            reply = {'ok': False, 'error': str(exc)}
        print(json.dumps(reply, ensure_ascii=False), file=output, flush=True)


if __name__ == '__main__':
    main()
