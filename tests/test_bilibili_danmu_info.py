import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from bilibili_api.utils import network
from urllib.parse import urlsplit

SCRIPT = Path(__file__).resolve().parents[1] / 'src/scripts/bilibili_danmu_info.py'
spec = importlib.util.spec_from_file_location('danmu_probe_test', SCRIPT)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
COOKIE = 'SESSDATA=session=encoded; bili_jct=csrf; DedeUserID=123; buvid3=abc-def-ghi; buvid4=stable-device'


class DanmuProbeTests(unittest.IsolatedAsyncioTestCase):
    async def test_risk_error_identifies_the_failed_endpoint_without_retries_or_secrets(self):
        for fail_path in ['/xlive/web-room/v1/index/getRoomPlayInfo', '/xlive/web-room/v1/index/getDanmuInfo']:
            requests = []

            async def request(**kwargs):
                path = urlsplit(kwargs['url']).path
                requests.append(path)
                if path == fail_path:
                    payload = {'code': -352, 'message': 'private-token-in-error'}
                elif path.endswith('/nav'):
                    payload = {'code': 0, 'data': {'wbi_img': {'img_url': 'https://example.invalid/' + 'a'*32 + '.png', 'sub_url': 'https://example.invalid/' + 'b'*32 + '.png'}}}
                else:
                    payload = {'code': 0, 'data': {'room_id': 123, 'uid': 456}}
                return network.BiliAPIResponse(code=200, headers={}, cookies={}, raw=json.dumps(payload).encode(), url=kwargs['url'])

            network.recalculate_wbi()
            with patch.object(network, 'get_client', return_value=SimpleNamespace(request=request)), \
                    patch('sys.stderr', new_callable=io.StringIO) as stderr:
                result = await probe.get_danmu_info('123', 'private-session', 'csrf', '456', 'abc-def', 'stable')
            self.assertEqual(result['code'], -352)
            self.assertEqual(result['endpoint'], fail_path)
            self.assertEqual(requests.count(fail_path), 1)
            self.assertNotIn('private-session', json.dumps(result) + stderr.getvalue())
            self.assertNotIn('private-token', json.dumps(result) + stderr.getvalue())

    async def test_preserves_full_device_identity_and_never_returns_token(self):
        api = AsyncMock(return_value={'host_list': [{}], 'token': 'private-websocket-token'})
        with patch.object(probe, 'Credential') as credential, \
                patch.object(probe.live, 'LiveRoom', return_value=SimpleNamespace(get_danmu_info=api)), \
                patch.object(probe.request_settings, 'set_enable_auto_buvid') as auto_buvid:
            result = await probe.get_danmu_info('123', 'session', 'csrf', '456', 'abc-def-ghi', 'stable-device')
        credential.assert_called_once_with(sessdata='session', bili_jct='csrf', dedeuserid='456', buvid3='abc-def-ghi', buvid4='stable-device')
        auto_buvid.assert_called_once_with(False)
        self.assertTrue(result['success'])
        self.assertNotIn('private-websocket-token', json.dumps(result))

    async def test_missing_device_identity_fails_before_network(self):
        with patch.object(probe.live, 'LiveRoom') as room:
            result = await probe.get_danmu_info('123', 'session', 'csrf', '456')
        self.assertFalse(result['success'])
        self.assertIn('buvid3', result['error'])
        room.assert_not_called()

    async def test_returns_structured_risk_code_without_sensitive_exception_text(self):
        error = RuntimeError('request included secret-session')
        error.code = -352
        with patch.object(probe, 'Credential'), \
                patch.object(probe.live, 'LiveRoom', return_value=SimpleNamespace(get_danmu_info=AsyncMock(side_effect=error))), \
                patch.object(probe.request_settings, 'set_enable_auto_buvid'), \
                patch('sys.stderr', new_callable=io.StringIO) as stderr:
            result = await probe.get_danmu_info('123', 'session', 'csrf', '456', 'abc-def', 'stable')
        self.assertEqual(result['code'], -352)
        self.assertNotIn('secret-session', json.dumps(result) + stderr.getvalue())

    def test_stdin_passes_cookie_values_without_argument_or_boundary_loss(self):
        values = probe.read_credentials(['probe.py', '123', '--credential-stdin'], io.StringIO(json.dumps({'cookie': COOKIE})))
        self.assertEqual(values, ('123', 'session=encoded', 'csrf', '123', 'abc-def-ghi', 'stable-device'))

    def test_similar_cookie_keys_do_not_supply_the_required_value(self):
        fields = probe.parse_cookie('other_SESSDATA=wrong; xbuvid3=wrong; buvid3=correct-with-hyphens')
        self.assertNotIn('SESSDATA', fields)
        self.assertEqual(fields['buvid3'], 'correct-with-hyphens')
        self.assertEqual(probe.parse_cookie('buvid3=first-full-value; buvid3=second')['buvid3'], 'first-full-value')

    def test_legacy_cli_only_uses_device_fields_from_the_same_login(self):
        loader = SimpleNamespace(get_config=Mock(return_value={'bilibili': {'cookie': COOKIE}}))
        with patch.dict(sys.modules, {'config_loader': loader}):
            matching = probe.read_credentials(['probe.py', '123', 'session=encoded', 'csrf', '123'], io.StringIO())
            different = probe.read_credentials(['probe.py', '123', 'another-session', 'csrf', '123'], io.StringIO())
        self.assertEqual(matching[-2:], ('abc-def-ghi', 'stable-device'))
        self.assertEqual(different[-2:], (None, None))


if __name__ == '__main__':
    unittest.main()
