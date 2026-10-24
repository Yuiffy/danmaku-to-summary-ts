from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/scripts/python'))
from asr_window_result import transcription_result, vad_intervals
from live_asr_cache import aggregate_chunks, missing_ranges


class AsrWindowResultTests(unittest.TestCase):
    def test_observed_silence_commits_coverage_without_inventing_subtitles(self):
        intervals = vad_intervals([{'key': 'silence', 'value': []}], 120)
        silence = {'start': 0, 'end': 120, 'result': transcription_result([], intervals)}
        speech = {'start': 120, 'end': 122, 'result': transcription_result(
            [{'text': '你好', 'timestamp': [[0, 200], [200, 400]]}], [[0, 400]])}
        self.assertEqual(missing_ranges([silence, speech], 122), [])
        result = aggregate_chunks([silence, speech])[0]
        self.assertEqual(result['text'].strip(), '你好')
        self.assertEqual(result['timestamp'], [[120000, 120200], [120200, 120400]])

    def test_empty_or_malformed_asr_after_speech_is_never_a_silent_checkpoint(self):
        for result in ([], None, [{}], [{'text': ''}], [{'text': 123}], [{'text': 'a'}, {'text': 'b'}]):
            with self.subTest(result=result), self.assertRaises(ValueError):
                transcription_result(result, [[0, 1000]])

    def test_unknown_vad_response_does_not_establish_silence(self):
        for result in ([], None, [{}], [{'value': None}], [{'value': [[0, 120001]]}],
                       [{'value': [[100, 0]]}], [{'value': [[0, float('nan')]]}]):
            with self.subTest(result=result), self.assertRaises(ValueError):
                vad_intervals(result, 60)

    def test_no_vad_cannot_authorize_empty_asr(self):
        with self.assertRaises(ValueError):
            transcription_result([], None)

    def test_valid_transcription_is_returned_unchanged(self):
        result = {'text': '原话', 'timestamp': [[0, 100]], 'sentence_info': []}
        self.assertIs(transcription_result([result], [[0, 100]]), result)


if __name__ == '__main__':
    unittest.main()
