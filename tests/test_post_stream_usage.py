import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / 'src' / 'scripts' / 'post_stream_usage.py'
spec = importlib.util.spec_from_file_location('post_stream_usage', MODULE)
usage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(usage)


class PostStreamUsageTest(unittest.TestCase):
    def test_unknown_usage_is_not_free(self):
        row = usage.request_record({'status': 'failure', 'model': 'gpt-5.6-luna'}, 'goodnight', 'file', 0)
        self.assertTrue(row['usageUnknown'])
        self.assertIsNone(row['estimatedTextUsd'])
        self.assertIsNone(row['promptTokens'])

    def test_partial_usage_remains_unknown_even_if_zero_tokens_are_reported(self):
        row = usage.request_record({'model': 'gpt-5.6-luna', 'promptTokens': 0, 'cachedTokens': 0,
                                    'completionTokens': 0, 'usageFinal': False, 'phase': 'evidence-review'}, 'reply-summary', 'file', 0)
        self.assertTrue(row['usageUnknown'])
        self.assertEqual(row['phase'], 'evidence-review')

    def test_output_already_contains_reasoning(self):
        row = usage.request_record({'model': 'gpt-5.6-luna', 'promptTokens': 1000, 'cachedTokens': 500,
                                    'completionTokens': 100, 'reasoningTokens': 80}, 'goodnight', 'file', 0)
        self.assertEqual(row['knownTokenTotal'], 1100)
        self.assertAlmostEqual(row['estimatedTextUsd'], 0.00023)

    def test_image_is_not_priced_as_text(self):
        row = usage.request_record({'model': 'gpt-image-2', 'usage': {'input_tokens': 1000, 'output_tokens': 500}}, 'image', 'file', 0)
        self.assertEqual(row['knownTokenTotal'], 1500)
        self.assertIsNone(row['estimatedTextUsd'])

    def test_image_modalities_have_separate_official_prices(self):
        row = usage.request_record({'model': 'gpt-image-2', 'usage': {'input_tokens': 8214,
            'input_tokens_details': {'image_tokens': 5200, 'text_tokens': 3014},
            'output_tokens': 1372, 'output_tokens_details': {'image_tokens': 1372}}}, 'image', 'file', 0)
        self.assertAlmostEqual(row['estimatedUncachedImageUsd'], 0.09783)

    def test_failed_recording_without_reply_keeps_its_known_cost(self):
        with tempfile.TemporaryDirectory() as directory:
            day = Path(directory) / '123_host' / '2026_09_08'
            day.mkdir(parents=True)
            (day / '\u5f55\u5236-123-20260908-120000-test_REPLY_SUMMARY.json').write_text(json.dumps({
                'roomId': '123', 'mode': 'paired', 'status': 'failed', 'attempts': [
                    {'model': 'gpt-5.6-luna', 'promptTokens': 1000, 'cachedTokens': 0, 'completionTokens': 100}
                ]}), encoding='utf8')
            records, errors = usage.collect(directory, '2026_09_08', '2026_09_08', {'123'})
            self.assertFalse(errors)
            self.assertEqual(len(records), 1)
            self.assertIsNone(records[0]['files']['reply'])
            self.assertGreater(records[0]['estimatedTextUsd'], 0)

    def test_shared_bundle_is_counted_once_and_old_diagnostic_is_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / 'record[1]'
            reply = Path(str(base) + usage.REPLY_SUFFIX)
            body = 'Ready reply!\r\nSecond sentence.'
            attempts = [{'model': 'gpt-5.6-luna', 'status': 'success', 'promptTokens': 1000,
                         'cachedTokens': 0, 'completionTokens': 100, 'responseId': 'response-1'}]
            reply.write_bytes(('---\nprovider: daiYu\nmodel: gpt-5.6-luna\nattempts:\n  []\n---\n' + body).encode())
            artifact = Path(str(base) + '_REPLY_SUMMARY.json')
            artifact.write_text(json.dumps({'status': 'success', 'mode': 'paired', 'roomId': '1',
                'replyBodySha256': hashlib.sha256(body.encode()).hexdigest(), 'attempts': attempts}), encoding='utf8')
            Path(str(base) + '_LIVE_CONTENT.json').write_text(json.dumps({'status': 'success', 'content': {'overview': 'test'},
                'generation': {'attempts': attempts, 'sharedUsagePath': artifact.name}}), encoding='utf8')
            Path(str(base) + '_COMIC_SCRIPT_META.json').write_text(json.dumps({'attempts': [dict(attempts[0], responseId='response-2')]}), encoding='utf8')
            diagnostic = root / (reply.stem + '_ATTEMPT1_old.md')
            diagnostic.write_text('# Historical diagnostic without usage', encoding='utf8')
            result = usage.inspect_recording(reply)
            self.assertEqual(result['mode'], 'paired')
            self.assertEqual(result['inputTokens'], 2000)
            self.assertEqual(result['outputTokens'], 200)
            self.assertEqual(result['unknownTextUsageRequests'], 1)
            self.assertEqual(len(result['requests']), 3)

    def test_metadata_and_summary_response_id_are_deduplicated(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / 'record'
            reply = Path(str(base) + usage.REPLY_SUFFIX)
            attempt = {'model': 'gpt-5.6-luna', 'promptTokens': 100, 'cachedTokens': 0,
                       'completionTokens': 10, 'responseId': 'same'}
            reply.write_text('---\n' + usage.yaml.safe_dump({'attempts': [attempt]}) + '---\nReady reply', encoding='utf8')
            Path(str(base) + '_LIVE_CONTENT.json').write_text(json.dumps({'generation': {'attempts': [attempt]}}), encoding='utf8')
            self.assertEqual(len(usage.inspect_recording(reply)['requests']), 1)


if __name__ == '__main__':
    unittest.main()
