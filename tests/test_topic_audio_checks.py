import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/scripts/python'))
from topic_audio_policy import check_alignment, decode_window


class TopicAudioPolicyTests(unittest.TestCase):
    def setUp(self):
        self.refs = [{'id': 'G1', 'text': '我记得当时觉得好震惊'},
                     {'id': 'G3', 'text': '看到了消息就必须要回'}]
        self.window = {'id': 'A1', 'hitIds': ['K1'], 'start': 10, 'end': 40, 'references': self.refs}
        self.text = '我记得当时觉得好震惊然后呢就被岁吉吐槽看到了消息就必须要回'

    def test_ordinary_context_matches_in_order_without_identity_claim(self):
        result = check_alignment(self.refs, self.text, ['岁己', '小岁'])
        self.assertEqual(result['status'], 'aligned')
        self.assertFalse(result['wordAlignmentVerified'])

    def test_wrong_timeline_does_not_match(self):
        result = check_alignment(self.refs, '兔子会吃屎你知道吗对兔子发情期怎么办在直播间唱歌', ['岁己'])
        self.assertEqual(result['status'], 'mismatch')

    def test_name_and_laughter_cannot_prove_alignment(self):
        refs = [{'id': 'G1', 'text': '岁己小岁岁己'}, {'id': 'G2', 'text': '哈哈哈哈哈哈哈哈'}]
        self.assertEqual(check_alignment(refs, '岁己小岁岁己哈哈哈哈哈哈哈哈', ['岁己', '小岁'])['status'], 'inconclusive')

    def test_same_transcript_characters_cannot_support_two_cues(self):
        refs = [{'id': 'G1', 'text': '看到了消息就必须要回'}, {'id': 'G2', 'text': '看到了消息就必须要回'}]
        self.assertNotEqual(check_alignment(refs, '看到了消息就必须要回', [])['status'], 'aligned')

    def test_reversed_context_is_not_aligned(self):
        self.assertNotEqual(check_alignment(self.refs, '看到了消息就必须要回我记得当时觉得好震惊', [])['status'], 'aligned')

    def test_silence_skips_both_decoders(self):
        decode = Mock()
        result = decode_window(self.window, object(), lambda _: [], decode, ['岁己'])
        self.assertEqual(result['status'], 'no_speech')
        self.assertIsNone(result['unprompted'])
        self.assertIsNone(result['biased'])
        decode.assert_not_called()

    def test_mismatch_does_not_try_hotword_prompt(self):
        decode = Mock(return_value={'text': '兔子发情期怎么办在直播间唱歌'})
        result = decode_window(self.window, object(), lambda _: [[0, 30]], decode, ['岁己'])
        self.assertEqual(result['status'], 'mismatch')
        self.assertEqual(decode.call_count, 1)
        self.assertEqual(decode.call_args.args[1], [])

    def test_success_preserves_separate_prompt_provenance(self):
        samples = object()
        decode = Mock(side_effect=[{'text': self.text}, {'text': self.text.replace('岁吉', '岁己')}])
        result = decode_window(self.window, samples, lambda _: [[0, 30]], decode, ['岁己'])
        self.assertEqual(result['status'], 'aligned')
        self.assertEqual([c.args for c in decode.call_args_list], [(samples, []), (samples, ['岁己'])])
        self.assertFalse(result['unprompted']['prompted'])
        self.assertTrue(result['biased']['prompted'])
        self.assertEqual(result['unprompted']['timingPrecision'], 'window')

    def test_empty_speech_output_is_failure(self):
        with self.assertRaises(ValueError):
            decode_window(self.window, object(), lambda _: [[0, 30]], lambda *_: {'text': ''}, ['岁己'])


if __name__ == '__main__':
    unittest.main()
