import base64
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src' / 'scripts'))
import tuzi_chat_completions as api


class ImageTransportTests(unittest.TestCase):
    def test_generation_usage_for_base64_url_empty_and_missing_usage(self):
        usage = {'input_tokens': 17, 'output_tokens': 29, 'total_tokens': 46}
        for data in ([{'b64_json': base64.b64encode(b'image').decode()}], [{'url': 'https://example.invalid/image.png'}], []):
            for raw_usage in (usage, None):
                with self.subTest(data=data, usage=raw_usage):
                    api.reset_last_image_generation_meta()
                    response = Mock(status_code=200, headers={}, elapsed=Mock(total_seconds=lambda: 1))
                    response.json.return_value = {'data': data, 'usage': raw_usage}
                    with patch.object(api.requests, 'post', return_value=response) as post, \
                         patch.object(api, 'check_image_api_rate_limit', return_value=True), \
                         patch.object(api, 'record_successful_image_api_call'), \
                         patch.object(api, 'save_image_bytes', return_value='result.png'), \
                         patch.object(api, 'download_image_to_temp', return_value='result.png'):
                        result = api.call_tuzi_images_generations('prompt', model='gpt-image-2.5-flare', quality='max', use_tuzi_retry=False)
                    self.assertEqual(result, 'result.png' if data else None)
                    self.assertEqual(post.call_args.kwargs['json']['quality'], 'max')
                    self.assertNotIn('response_format', post.call_args.kwargs['json'])
                    meta = api.get_last_image_generation_meta()
                    self.assertEqual(meta.get('usage') or None, raw_usage)
                    self.assertEqual(meta['attempts'][-1].get('usage'), raw_usage)

    def test_reference_image_uses_edits_with_max_and_usage(self):
        usage = {'input_tokens': 101, 'output_tokens': 202}
        api.reset_last_image_generation_meta()
        response = Mock(status_code=200, headers={}, elapsed=Mock(total_seconds=lambda: 2))
        response.json.return_value = {'data': [{'b64_json': 'aW1hZ2U='}], 'usage': usage}
        with tempfile.TemporaryDirectory() as folder:
            reference = Path(folder) / 'reference.png'
            reference.write_bytes(b'reference')
            with patch.object(api.requests, 'post', return_value=response) as post, \
                 patch.object(api, 'check_image_api_rate_limit', return_value=True), \
                 patch.object(api, 'record_successful_image_api_call'), \
                 patch.object(api, 'try_extract_image_from_data_items', return_value='result.png'):
                result = api.call_tuzi_images_generations('prompt', str(reference), model='gpt-image-2.5-sunburst', quality='max', use_tuzi_retry=False)
            self.assertEqual(result, 'result.png')
            self.assertTrue(post.call_args.args[0].endswith('/images/edits'))
            self.assertEqual(post.call_args.kwargs['data']['quality'], 'max')
            self.assertEqual(api.get_last_image_generation_meta()['usage'], usage)
