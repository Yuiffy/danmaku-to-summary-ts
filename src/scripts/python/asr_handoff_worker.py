"""One device per process. Private JSONL protocol; EOF terminates in-flight work."""
import contextlib
import faulthandler
import gc
import json
import os
import queue
import sys
import threading
import time


def serve():
    requests = queue.Queue()
    # Blocking Python/CRT stdin reads on Windows hold the CRT descriptor lock.
    # NumPy's native initialization inspects that descriptor and can deadlock.
    # Read the OS pipe directly, without holding the Python or CRT stream lock.
    descriptor = sys.stdin.fileno()
    if os.name == 'nt':
        import ctypes
        import msvcrt
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        read_file = kernel.ReadFile
        read_file.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong,
                              ctypes.POINTER(ctypes.c_ulong), ctypes.c_void_p]
        read_file.restype = ctypes.c_bool
        peek = kernel.PeekNamedPipe
        peek.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p,
                         ctypes.POINTER(ctypes.c_ulong), ctypes.c_void_p]
        peek.restype = ctypes.c_bool
        handle = msvcrt.get_osfhandle(descriptor)
        def read_pipe():
            # Even a direct synchronous ReadFile holds the OS pipe object's
            # read lock. Native libraries inspect stdin during initialization.
            # Poll readiness so no blocking read is active during DLL imports.
            available = ctypes.c_ulong()
            while True:
                if not peek(handle, None, 0, None, ctypes.byref(available), None):
                    error = ctypes.get_last_error()
                    if error in (109, 232):
                        return b''
                    raise ctypes.WinError(error)
                if available.value:
                    break
                time.sleep(0.05)
            buffer = ctypes.create_string_buffer(65536)
            count = ctypes.c_ulong()
            if not read_file(handle, buffer, min(len(buffer), available.value), ctypes.byref(count), None):
                error = ctypes.get_last_error()
                if error in (109, 232):
                    return b''
                raise ctypes.WinError(error)
            return buffer.raw[:count.value]
    else:
        def read_pipe():
            return os.read(descriptor, 65536)
    def receive():
        pending = b''
        try:
            while True:
                data = read_pipe()
                if not data:
                    break
                pending += data
                while b'\n' in pending:
                    line, pending = pending.split(b'\n', 1)
                    requests.put(json.loads(line.decode('utf-8')))
        finally:
            # Parent cancellation/timeout must not leave an inference child behind.
            os._exit(1)
    threading.Thread(target=receive, daemon=True).start()
    output = sys.stdout
    from asr_handoff_model import HandoffModelState
    models = HandoffModelState()
    payload, guard = None, None
    try:
        while True:
            request = requests.get()
            faulthandler.dump_traceback_later(120, file=sys.stderr)
            with contextlib.redirect_stdout(sys.stderr):
                operation = request['op']
                if operation == 'init':
                    if guard is not None:
                        guard.close_claim()
                    payload = request['payload']
                    from asr_cpu_fallback import apply_cpu_fallback
                    apply_cpu_fallback(payload)
                    from sensevoice_runtime import prepare_asr_runtime
                    # Device admission is owned by the supervisor at window boundaries.
                    runtime = {**payload, 'resource_guard': {**(payload.get('resource_guard') or {}),
                               'pause_when_game_running': False}}
                    guard = prepare_asr_runtime(runtime)
                    cache_hit = models.begin(payload)
                    response = {'ready': True, 'device': payload['device'], 'model_cache_hit': cache_hit}
                elif operation == 'window':
                    began = time.perf_counter()
                    load_s = 0
                    import torch
                    from funasr import AutoModel
                    from asr_handoff_checkpoint import read_pcm
                    from live_asr_cache import commit_boundary, model_spec, aggregate_chunks
                    from sensevoice_paraformer import configure_paraformer_devices
                    from sensevoice_text import resolve_cached_model_name
                    from asr_window_result import vad_intervals
                    from asr_vad_reuse import generate_with_vad
                    def load_model(options):
                        spec = model_spec(options)
                        kwargs = {k: v for k, v in spec.items() if k != 'audio_timeline'}
                        for key in ('model', 'vad_model', 'punc_model'):
                            if kwargs[key]:
                                kwargs[key] = resolve_cached_model_name(kwargs[key])
                        loaded = AutoModel(**kwargs, device=options['device'],
                                          ncpu=2 if options['device'] == 'cpu' else 4,
                                          disable_update=True, disable_pbar=True)
                        configure_paraformer_devices(loaded, options['device'], options.get('vad_device') or 'cpu')
                        return loaded
                    model, load_s, restore_s = models.get(payload, load_model)
                    audio = read_pcm(request['pcm'], request['start'], request['duration'])
                    vad_started = time.perf_counter()
                    with torch.inference_mode():
                        vad = (model.inference(audio, model=model.vad_model,
                            kwargs={**model.vad_kwargs}, disable_pbar=True)
                            if getattr(model, 'vad_model', None) is not None else [])
                        intervals = vad_intervals(vad, len(audio) / 16000) if getattr(model, 'vad_model', None) is not None else None
                        vad_s = time.perf_counter() - vad_started
                        end = commit_boundary(intervals or [], len(audio) / 16000,
                                              final=request['final'])
                        if end is None:
                            response = {'chunk': None}
                        else:
                            frames = min(len(audio), round(end * 16000))
                            from asr_handoff_policy import batch_settings
                            batch, threshold = batch_settings({**payload,
                                **{key: request[key] for key in ('batch_size_s', 'batch_size_threshold_s') if key in request}}, payload['device'])
                            metrics = {}
                            generate_started = time.perf_counter()
                            result = generate_with_vad(model, audio[:frames], vad, metrics=metrics, cache={}, batch_size_s=batch,
                                batch_size_threshold_s=threshold, sentence_timestamp=True, disable_pbar=True,
                                language=payload.get('language', 'auto'), use_itn=payload.get('use_itn', True))
                            response = {'chunk': {'start': request['start'],
                                'end': round(request['start'] + frames / 16000, 5),
                                'result': result}, 'vad_reused': metrics.get('vad_reused', 0),
                                'empty_decoding': metrics.get('empty_decoding', 0),
                                'generation_s': time.perf_counter() - generate_started}
                            aggregate_chunks([response['chunk']])
                    response.update(model_load_s=load_s, vad_s=vad_s, window_s=time.perf_counter()-began,
                        model_restore_s=restore_s,
                        gpu_reserved_mb=torch.cuda.memory_reserved() / 1024 ** 2
                            if payload['device'].startswith('cuda') else 0)
                elif operation == 'finish':
                    speaker_policy = request.get('speaker_processing_policy') or payload.get('speaker_processing_policy')
                    if speaker_policy:
                        payload['speaker_processing_policy'] = speaker_policy
                        if speaker_policy.get('enabled') is False:
                            payload['enable_speaker'] = False
                    # Drop the local reference before clearing/offloading reusable weights.
                    model = None
                    park_started = time.perf_counter()
                    models.before_finish(payload, request.get('retain_model') is True)
                    park_s = time.perf_counter() - park_started
                    from live_asr_cache import aggregate_chunks
                    from paraformer_postprocess import postprocess_cached_paraformer
                    from sensevoice_runtime import GpuThrottle
                    payload['_timings'] = {**request['timings'], 'handoff_model_park_s': park_s,
                                           'handoff_model_retained': int(models.model is not None)}
                    payload['_resource_peaks'] = {}
                    began = time.perf_counter()
                    segments = postprocess_cached_paraformer(payload, payload['audio_path'], payload['device'],
                        aggregate_chunks(request['chunks']), {}, GpuThrottle(payload, payload['device']), began)
                    response = {'backend': 'paraformer', 'language': payload.get('language', 'auto'),
                        'segments': segments, 'timings': payload['_timings'],
                        'resource_peaks': payload['_resource_peaks'],
                        'speaker_processing': payload.get('_speaker_processing'),
                        'emotion_analysis': payload.get('_emotion_analysis')}
                    if payload.get('include_raw'):
                        response['raw'] = segments
                    from sensevoice_text import _apply_hotword_correction
                    if (payload.get('phoneme_correction') or {}).get('enabled'):
                        _apply_hotword_correction(response, payload)
                elif operation == 'release':
                    if guard is not None:
                        guard.close_claim()
                        guard = None
                    import torch
                    gc.collect()
                    if payload['device'].startswith('cuda'):
                        torch.cuda.empty_cache()  # Drop allocator blocks from optional postprocessing.
                    response = {'released': True, 'model_retained': models.model is not None,
                        'gpu_reserved_mb': torch.cuda.memory_reserved() / 1024 ** 2
                            if payload['device'].startswith('cuda') else 0}
                elif operation == 'close':
                    return
                else:
                    raise ValueError('Unknown ASR handoff operation')
            print(json.dumps(response, ensure_ascii=False, default=str), file=output, flush=True)
            faulthandler.cancel_dump_traceback_later()
    finally:
        if guard is not None:
            guard.close_claim()


if __name__ == '__main__':
    serve()
