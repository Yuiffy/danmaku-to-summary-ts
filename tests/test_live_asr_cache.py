import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/scripts/python'))
from live_asr_cache import (aggregate_chunks, atomic_json, cache_path, commit_boundary,
    finish_cached_transcript, missing_ranges, model_spec, source_identity, validate_chunks)


def chunk(start, end, text='你好'):
    return {'start': start, 'end': end, 'result': {'text': text,
        'timestamp': [[100, 200], [200, 300]],
        'sentence_info': [{'text': text, 'start': 100, 'end': 300}]}}


class LiveAsrCacheTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg is required for timestamp-gap integration')
    def test_timestamp_gaps_remain_silence_on_the_recording_timeline(self):
        import numpy as np
        from live_asr_cache import decode_window
        from sensevoice_speaker import load_audio_16k_mono
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'gapped.mkv'
            subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-f', 'lavfi',
                '-i', 'sine=frequency=440:sample_rate=16000:duration=4',
                '-af', r'asetpts=PTS+gte(T\,1)*0.65/TB', '-c:a', 'pcm_f32le', str(source)],
                check=True, capture_output=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), timeout=20)
            window = decode_window(source, 0, 4.6)
            whole, rate = load_audio_16k_mono(source, align_timestamps=True)
            self.assertEqual(len(window), round(4.6 * 16000))
            self.assertEqual(rate, 16000)
            np.testing.assert_allclose(window, whole[:len(window)], atol=0.0001)
            later = decode_window(source, 2, 2)
            np.testing.assert_allclose(later, whole[32000:64000], atol=0.0001)
            self.assertLess(float(np.max(np.abs(window[20000:24000]))), 0.001)
            self.assertGreater(float(np.max(np.abs(window[30000:40000]))), 0.05)

    def test_vad_commits_last_observed_pause_and_retains_unfinished_speech(self):
        self.assertEqual(commit_boundary([[0, 20000], [23000, 57000]], 60), 57)
        self.assertEqual(commit_boundary([[0, 20000], [23000, 60000]], 60), 20)
        self.assertIsNone(commit_boundary([[0, 60000]], 60))
        self.assertEqual(commit_boundary([[0, 120000]], 120), 120)
        self.assertEqual(commit_boundary([[0, 12000]], 12, final=True), 12)
        self.assertEqual(commit_boundary([], 60), 60)

    def test_offsets_stay_in_seconds_for_coverage_and_milliseconds_for_funasr(self):
        pieces = [chunk(0, 57), chunk(57, 116)]
        result = aggregate_chunks(pieces)[0]
        self.assertEqual(result['timestamp'][2], [57100, 57200])
        self.assertEqual(result['sentence_info'][1]['start'], 57100)
        self.assertEqual(missing_ranges(pieces, 120), [(116, 120)])
        self.assertEqual(pieces[1]['result']['timestamp'][0], [100, 200])

    def test_holes_are_explicit_and_overlap_and_invalid_timestamps_are_rejected(self):
        self.assertEqual(missing_ranges([chunk(20, 57), chunk(70, 90)], 100), [(0, 20), (57, 70), (90, 100)])
        for pieces in ([chunk(0, 57), chunk(56, 80)], [chunk(float('nan'), 80)], [chunk(0, 0.01)]):
            with self.assertRaises(ValueError):
                validate_chunks(pieces)

    def test_final_reuses_completed_audio_and_only_infers_internal_hole_and_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'recording.flv'
            source.write_bytes(b'x' * 150000)
            payload = {'room_id': '25788785', 'live_asr': {'enabled': True, 'room_ids': ['25788785']}}
            value = {'version': 1, 'room_id': '25788785', 'spec': model_spec(payload),
                     'source': source_identity(source), 'chunks': [chunk(0, 57), chunk(70, 90)]}
            atomic_json(cache_path(source), value)
            calls = []
            class Infer:
                def __init__(self, _): pass
                def window(self, source, start, size, final):
                    calls.append((start, size, final))
                    return chunk(start, start + size)
            result = finish_cached_transcript(payload, str(source), infer_factory=Infer, probe=lambda _: 100)
            self.assertEqual(calls, [(57, 13, True), (90, 10, True)])
            self.assertEqual(payload['_timings']['live_asr_reused_audio_s'], 77)
            self.assertEqual(len(result[0]['sentence_info']), 4)
            # The offline consumer does not race the live producer's checkpoint writer.
            self.assertEqual(json.loads(cache_path(source).read_text(encoding='utf-8'))['chunks'], value['chunks'])

    def test_full_cache_never_constructs_asr_model_and_mismatch_falls_back(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'recording.flv'
            source.write_bytes(b'x' * 150000)
            payload = {'room_id': '25788785', 'live_asr': {'enabled': True, 'room_ids': ['25788785']}}
            value = {'version': 1, 'room_id': '25788785', 'spec': model_spec(payload),
                     'source': source_identity(source), 'chunks': [chunk(0, 60)]}
            atomic_json(cache_path(source), value)
            def forbidden(_): raise AssertionError('Cached audio must not be transcribed again')
            self.assertIsNotNone(finish_cached_transcript(payload, str(source), forbidden, lambda _: 60))
            for mutation in ('room', 'model', 'source', 'disabled'):
                changed = copy.deepcopy(payload)
                if mutation == 'room': changed['room_id'] = '123'
                if mutation == 'model': changed['model'] = 'different-model'
                if mutation == 'disabled': changed['live_asr']['enabled'] = False
                if mutation == 'source': source.write_bytes(b'y' * 150000)
                self.assertIsNone(finish_cached_transcript(changed, str(source), forbidden, lambda _: 60))


if __name__ == '__main__':
    unittest.main()
