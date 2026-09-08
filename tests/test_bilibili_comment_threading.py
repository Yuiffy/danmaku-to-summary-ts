import base64
import importlib.util
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

SCRIPT = Path(__file__).resolve().parents[1] / 'src' / 'scripts' / 'bilibili_comment.py'
spec = importlib.util.spec_from_file_location('bilibili_comment_threading', SCRIPT)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class CommentThreadingTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.credential = SimpleNamespace(ac_time_value=None, check_valid=AsyncMock(return_value=True))
        self.build = patch.object(publisher, 'build_credential', return_value=self.credential).start()
        patch.object(publisher, 'refresh_credential_if_needed', AsyncMock(return_value=(self.credential, False))).start()
        patch.object(publisher, 'get_dynamic_comment_id', AsyncMock(return_value=('999', publisher.CommentResourceType.DYNAMIC_DRAW))).start()
        self.send = patch.object(publisher.comment, 'send_comment', AsyncMock(return_value={'rpid': 98765432109876543210})).start()
        patch.object(publisher, 'log').start()
        patch.object(publisher, 'safe_print_exc').start()
        self.addCleanup(patch.stopall)

    async def test_child_sets_root_and_parent_without_losing_integer_precision(self):
        result = await publisher.publish_comment('123', 'Summary', 'session', 'csrf', '456', reply_to_id='12345678901234567890')
        self.assertTrue(result['success'])
        self.assertEqual(result['reply_id'], '98765432109876543210')
        kwargs = self.send.await_args.kwargs
        self.assertEqual(kwargs['root'], 12345678901234567890)
        self.assertEqual(kwargs['parent'], 12345678901234567890)
        self.assertEqual(kwargs['oid'], 999)

    async def test_top_level_call_does_not_add_threading_parameters(self):
        await publisher.publish_comment('123', 'Goodnight', 'session', 'csrf', '456')
        self.assertNotIn('root', self.send.await_args.kwargs)
        self.assertNotIn('parent', self.send.await_args.kwargs)

    async def test_missing_or_deleted_parent_is_not_retried_at_top_level(self):
        self.send.side_effect = RuntimeError('parent comment no longer exists')
        result = await publisher.publish_comment('123', 'Summary', 'session', 'csrf', '456', reply_to_id='777')
        self.assertFalse(result['success'])
        self.send.assert_awaited_once()
        self.assertEqual(self.send.await_args.kwargs['root'], 777)

    async def test_invalid_parent_is_rejected_before_credential_or_network_work(self):
        for value in ('', '0', '-1', '1e20', '1.5', ' 123', 123, True):
            with self.subTest(value=value):
                result = await publisher.publish_comment('123', 'Summary', 'session', 'csrf', '456', reply_to_id=value)
                self.assertFalse(result['success'])
        self.build.assert_not_called()
        self.send.assert_not_awaited()


class CommentThreadingCliTest(unittest.TestCase):
    def test_cli_keeps_optional_image_and_credentials_positions(self):
        credentials = base64.b64encode(json.dumps({'buvid3': 'test'}).encode()).decode()
        argv = [str(SCRIPT), '123', 'Summary', 'session', 'csrf', '456', '', credentials, '12345678901234567890']
        publish = AsyncMock(return_value={'success': True, 'reply_id': '999'})
        with patch.object(publisher.sys, 'argv', argv), patch.object(publisher, 'publish_comment', publish), \
                patch.object(publisher, 'print'), patch.object(publisher, 'json_print'):
            with self.assertRaises(SystemExit) as exit_result:
                publisher.main()
        self.assertEqual(exit_result.exception.code, 0)
        publish.assert_awaited_once_with('123', 'Summary', 'session', 'csrf', '456', None, {'buvid3': 'test'}, '12345678901234567890')


if __name__ == '__main__':
    unittest.main()
