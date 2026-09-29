import tempfile
import json
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from moss_http import read_transcript_stream, transcribe_http, validate_response


class MossHttpTests(unittest.TestCase):
    def test_preserves_simultaneous_different_speakers_and_words(self):
        rows = [{'start': 0, 'end': 3, 'speaker': 'S01', 'text': 'first voice'},
                {'start': 1, 'end': 2, 'speaker': 'S02', 'text': 'second voice'}]
        actual = validate_response({'segments': rows}, 4, 100)
        self.assertEqual(actual['segments'], rows)
        self.assertIsNone(actual['generated_tokens'])

    def test_rejects_truncation_invalid_time_or_unverified_name(self):
        row = {'start': 0, 'end': 3, 'speaker': 'S01', 'text': 'hello'}
        for change in [{'start': -1}, {'end': 8}, {'end': float('nan')},
                       {'speaker': 'Known Person'}, {'text': ''}, {'end': 0}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_response({'segments': [{**row, **change}]}, 4, 100)
        for extra in [{'finish_reason': 'length'}, {'usage': {'completion_tokens': 100}}]:
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                validate_response({'segments': [row], **extra}, 4, 100)
        with self.assertRaises(ValueError):
            validate_response({'text': 'unparsed generation', 'segments': []}, 4, 100)

    def test_empty_silence_response_is_distinct_from_missing_contract(self):
        self.assertEqual(validate_response({'text': '', 'segments': []}, 4, 100)['segments'], [])
        with self.assertRaises(ValueError):
            validate_response({'text': ''}, 4, 100)

    def test_sends_explicit_limit_and_does_not_retry_truncated_http_response(self):
        with tempfile.TemporaryDirectory() as temp:
            audio = Path(temp) / 'probe.wav'
            audio.write_bytes(b'RIFF')
            response = Mock(ok=False, status_code=400, text='incomplete diarized transcript')
            with patch('requests.post', return_value=response) as post:
                with self.assertRaisesRegex(RuntimeError, 'incomplete diarized'):
                    transcribe_http(audio, {'base_url': 'http://127.0.0.1:123/v1'}, 5400, 300)
                post.assert_called_once()
                self.assertEqual(post.call_args.kwargs['data']['max_completion_tokens'], '5400')
                self.assertEqual(post.call_args.kwargs['data']['response_format'], 'json')
                self.assertEqual(post.call_args.kwargs['data']['stream_include_usage'], 'true')
                response.close.assert_called_once()

    def test_stream_preserves_overlap_and_requires_eos_usage_and_complete_tail(self):
        def frames(text, reason='stop', tokens=25):
            return [b'', ('data: ' + json.dumps({'choices': [{'delta': {'content': text[:9]}}]})).encode(),
                    'data: ' + json.dumps({'choices': [{'delta': {'content': text[9:]}, 'finish_reason': reason}]}),
                    'data: ' + json.dumps({'usage': {'completion_tokens': tokens}, 'choices': []}),
                    'data: [DONE]']
        text = '[0.00][S01]first[3.00][1.00][S02]second[2.00]'
        result = read_transcript_stream(frames(text), 4, 100)
        self.assertEqual(result['generated_tokens'], 25)
        self.assertEqual(result['segments'][1]['start'], 1)
        for stream in [frames(text, 'length'), frames(text, tokens=100),
                       frames(text)[:-1], frames(text)[:2] + ['data: [DONE]'],
                       frames(text + '[3.00][S01]unfinished')]:
            with self.subTest(stream=stream), self.assertRaises(ValueError):
                read_transcript_stream(stream, 4, 100)


if __name__ == '__main__':
    unittest.main()
