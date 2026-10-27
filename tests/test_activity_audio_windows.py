import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.scripts.python import activity_audio_evidence
from src.scripts.python.activity_audio_evidence import packet_windows, windows


class ActivityAudioWindowTests(unittest.TestCase):
    def test_long_explicit_review_has_continuous_original_clock(self):
        spans = packet_windows(1480.125, 8)
        self.assertEqual(spans[0], (0, 8))
        self.assertEqual(spans[149:152], [(1192, 1200), (1200, 1208), (1208, 1216)])
        self.assertEqual(spans[-1][1], 1480.125)
        self.assertTrue(all(0 < end - start <= 8 for start, end in spans))
        self.assertTrue(all(left[1] == right[0] for left, right in zip(spans, spans[1:])))

    def test_nondivisor_chunk_size_preserves_continuity(self):
        spans = packet_windows(2400.5, 7)
        self.assertEqual(spans[0][0], 0)
        self.assertEqual(spans[-1][1], 2400.5)
        self.assertTrue(all(0 < end - start <= 7 for start, end in spans))
        self.assertTrue(all(left[1] == right[0] for left, right in zip(spans, spans[1:])))

    def test_short_packet_is_unchanged_and_decoder_limit_remains(self):
        self.assertEqual(packet_windows(162.5, 8), windows(162.5, 8))
        with self.assertRaises(ValueError):
            windows(1200.1, 8)
        for duration, seconds in [(0, 8), (-1, 8), (1600, 0), (1600, 17)]:
            with self.subTest(duration=duration, seconds=seconds), self.assertRaises(ValueError):
                packet_windows(duration, seconds)

    def test_total_packet_budget_still_fails_before_loading_models(self):
        with tempfile.TemporaryDirectory() as directory:
            request = Path(directory) / 'input.json'
            request.write_text(json.dumps({'audio': [{'start': 0, 'end': 1480}],
                                           'maxAudioSeconds': 600}), encoding='utf-8')
            with patch('sys.argv', ['decoder', str(request), str(Path(directory) / 'output.json')]), \
                    patch.object(activity_audio_evidence, 'analyze') as analyze:
                with self.assertRaisesRegex(ValueError, 'exceeds the batch budget'):
                    activity_audio_evidence.main()
                analyze.assert_not_called()


if __name__ == '__main__':
    unittest.main()
