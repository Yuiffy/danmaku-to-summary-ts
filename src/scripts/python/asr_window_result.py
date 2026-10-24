"""Validate bounded VAD/ASR responses without confusing silence with model failure."""
import math


def vad_intervals(result, duration):
    if not isinstance(result, list) or len(result) != 1 or not isinstance(result[0], dict):
        raise ValueError('No valid VAD output; checkpoint not advanced')
    intervals = result[0].get('value')
    if not isinstance(intervals, list):
        raise ValueError('No valid VAD intervals; checkpoint not advanced')
    for row in intervals:
        if (not isinstance(row, (list, tuple)) or len(row) != 2
                or not all(isinstance(x, (int, float)) and math.isfinite(x) for x in row)
                or not 0 <= row[0] <= row[1] <= duration * 1000 + 250):
            raise ValueError('VAD interval outside audio window; checkpoint not advanced')
    return intervals


def transcription_result(results, intervals):
    # FunASR returns [] for a window with no detected speech. Preserve its
    # observed coverage, but never substitute empty text after detected speech.
    if results == [] and intervals == []:
        return {'text': '', 'timestamp': [], 'sentence_info': []}
    if not isinstance(results, list) or len(results) != 1 or not isinstance(results[0], dict):
        raise ValueError('No valid FunASR output; checkpoint not advanced')
    result = results[0]
    if not isinstance(result.get('text'), str) or intervals and not result['text'].strip():
        raise ValueError('FunASR omitted detected speech; checkpoint not advanced')
    return result
