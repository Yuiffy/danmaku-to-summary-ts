"""Reuse validated window VAD while retaining FunASR batching and timestamp logic."""
import copy

from asr_window_result import transcription_result, vad_intervals


def generate_with_vad(model, audio, vad, *, metrics=None, **config):
    """An isolated model has one request at a time; always restore its adapter.

    ``vad`` was validated against the full observed window by the caller. Project
    it onto the committed prefix so uncommitted speech cannot affect validation.
    """
    if getattr(model, 'vad_model', None) is None:
        return transcription_result(model.generate(input=audio, **config), None)
    duration = len(audio) / 16000
    projected = [{**vad[0], 'value': [[start, min(end, duration * 1000)]
        for start, end in vad[0]['value'] if start < min(end, duration * 1000)]}]
    intervals = vad_intervals(projected, duration)
    if not intervals:
        return transcription_result([], [])
    original = model.inference
    had_override = 'inference' in vars(model)
    previous = vars(model).get('inference')
    native = []
    native_valid = True
    reused = 0

    def inference(value, *args, **kwargs):
        nonlocal native_valid, reused
        if kwargs.get('model') is model.vad_model and value is audio:
            reused += 1
            # FunASR can mutate VAD rows when merge_vad is enabled.
            return copy.deepcopy(projected)
        result = original(value, *args, **kwargs)
        if kwargs.get('model') is model.model:
            if isinstance(result, list):
                native.extend(result)
            else:
                native_valid = False
        return result

    model.inference = inference
    try:
        results = model.generate(input=audio, **config)
    finally:
        if had_override:
            model.inference = previous
        else:
            del model.inference
    if metrics is not None:
        metrics['vad_reused'] = int(reused > 0)
    # The aggregate drops native empty decodes. Accept them only when every
    # observed region actually reached ASR and returned an explicit empty result.
    # A missing/malformed result or swallowed nonempty text remains a failure.
    if (results == [] and reused == 1 and native_valid and len(native) == len(intervals)
            and all(isinstance(row, dict) and row.get('text') == ''
                    and row.get('timestamp') == [] for row in native)):
        if metrics is not None:
            metrics['empty_decoding'] = 1
        return {'text': '', 'timestamp': [], 'sentence_info': []}
    return transcription_result(results, intervals)
