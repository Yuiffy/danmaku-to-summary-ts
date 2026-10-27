import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, redirect_stdout
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from src.scripts import clip_upload_pacing as pacing


class UploadPacingTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / 'pacing.sqlite3'
        self.now = 1000.0
        self.waits = []
        self.logs = []

    async def sleep(self, seconds):
        self.waits.append(seconds)
        self.now += seconds

    def pacer(self, account='one'):
        return pacing.UploadPacing(account, self.database, clock=lambda: self.now,
                                   sleep=self.sleep, emit=self.logs.append)

    def events(self, event):
        with closing(sqlite3.connect(self.database)) as db:
            return db.execute('SELECT at,part_index,http_status FROM upload_events WHERE event=? ORDER BY id',
                              (event,)).fetchall()

    def long_406(self):
        for minute in range(0, 181, 10):
            self.now = 1000 + minute * 60
            self.pacer().record('preupload_failed', 'preupload', 406, 1)

    def status(self, account='one'):
        return pacing.protection_status(account, self.database, now=self.now)

    def test_three_hour_boundary_enters_slow_once_and_success_keeps_it(self):
        for minute in range(0, 180, 10):
            self.now = 1000 + minute * 60
            self.pacer().record('preupload_failed', 'preupload', 406, 1)
        self.assertFalse(self.status()['slow'])
        self.now = 1000 + 180 * 60
        self.pacer().record('preupload_failed', 'preupload', 406, 1)
        state = self.status()['state']
        self.assertEqual(state['failures'], 19)
        self.assertEqual(state['slowUntil'], self.now + 86400)
        self.pacer().record('archive_complete', 'submit', 200)
        self.assertTrue(self.status()['slow'])
        self.assertNotIn('first406At', self.status()['state'])
        notify = Mock(return_value=True)
        self.pacer().deliver_alerts(notify)
        self.pacer().deliver_alerts(notify)
        notify.assert_called_once()
        self.assertIn('每十分钟', notify.call_args.args[0])
        self.assertFalse(self.status('other')['slow'])

    def test_idle_or_non406_outcome_breaks_continuous_failures(self):
        for break_event in ('idle', 'archive_complete', 'upload_failed', 'preupload_failed'):
            with self.subTest(break_event=break_event):
                pacer = self.pacer(break_event)
                self.now = 1000
                for minute in range(0, 171, 10):
                    self.now = 1000 + minute * 60
                    pacer.record('preupload_failed', 'preupload', 406, 1)
                if break_event == 'idle':
                    self.now += 1801
                else:
                    pacer.record(break_event, 'submit', 503 if break_event != 'archive_complete' else 200)
                    self.now += 600
                pacer.record('preupload_failed', 'preupload', 406, 1)
                state = self.status(break_event)
                self.assertFalse(state['slow'])
                self.assertEqual(state['state']['failures'], 1)

    def test_slow_mode_spaces_archives_but_keeps_multipart_and_expires(self):
        self.pacer().activate_slow('confirmed historical incident')
        self.assertEqual(self.pacer().reserve(1), 0)
        self.assertEqual(self.pacer().reserve(2), 0)
        self.assertEqual(self.pacer().reserve(1), 600)
        self.now += 599
        self.assertEqual(self.pacer().reserve(1), 1)
        self.now += 1
        self.assertEqual(self.pacer().reserve(1), 0)
        self.assertEqual(self.status()['waitSeconds'], 600)
        self.now = 1000 + 86400
        self.assertFalse(self.status()['slow'])
        self.assertEqual(self.pacer().reserve(1), 0)
        self.assertEqual(self.pacer().reserve(1), 0)

    def test_slow_reservation_is_atomic_across_clients(self):
        self.pacer().activate_slow('confirmed incident')
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.pacer().reserve(1), range(8)))
        self.assertEqual(results.count(0), 1)
        self.assertEqual(results.count(600), 7)

    def test_next_406_latches_pause_across_restart_expiry_and_success_until_manual_resume(self):
        self.long_406()
        self.now += 600
        self.pacer().record('upload_failed', 'submitting', 406)
        self.assertTrue(self.status()['paused'])
        self.pacer().record('archive_complete', 'submit', 200)
        self.now += 2 * 86400
        self.assertTrue(self.status()['paused'])
        output = io.StringIO()
        with patch.object(pacing.time, 'time', return_value=self.now), redirect_stdout(output):
            pacing.print_statistics(self.database)
        self.assertTrue(json.loads(output.getvalue())['protection']['one']['paused'])
        with self.assertRaises(pacing.UploadPaused):
            self.pacer().reserve(2)
        with self.assertRaises(ValueError):
            self.pacer().activate_slow('must not silently unpause')
        self.assertEqual(self.events('preupload_start'), [])
        notify = Mock(return_value=True)
        self.pacer().deliver_alerts(notify)
        self.assertEqual(notify.call_count, 2)
        self.assertIn('等待人工处理', notify.call_args.args[0])
        self.pacer().resume('operator confirmed recovery')
        self.assertFalse(self.status()['paused'])
        self.assertTrue(self.status()['slow'])
        self.assertEqual(self.pacer().reserve(1), 0)

    def test_alert_retry_survives_restart_and_does_not_release_protection(self):
        self.pacer().activate_slow('confirmed incident')
        self.pacer().record('preupload_failed', 'preupload', 406, 1)
        notify = Mock(side_effect=RuntimeError('secret webhook token'))
        self.pacer().deliver_alerts(notify)
        self.assertTrue(self.status()['paused'])
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute('SELECT DISTINCT error FROM upload_alerts').fetchall(), [('RuntimeError',)])
        self.assertNotIn('secret', ''.join(self.logs))
        notify.reset_mock(side_effect=True)
        notify.return_value = True
        self.pacer().deliver_alerts(notify)
        notify.assert_not_called()
        self.now += 300
        self.pacer().deliver_alerts(notify)
        self.assertEqual(notify.call_count, 2)
        self.pacer().deliver_alerts(notify)
        self.assertEqual(notify.call_count, 2)

    def test_paused_sdk_never_initializes_or_calls_authorization_adapter(self):
        self.pacer().activate_slow('confirmed incident')
        self.pacer().record('preupload_failed', 'preupload', 406, 1)
        page = object()
        sdk = AsyncMock()
        class SDK:
            _preupload = sdk
        authorize = Mock()
        uploader = pacing.paced_uploader_type(SDK, self.pacer(), [page], authorize)()
        with self.assertRaises(pacing.UploadPaused):
            asyncio.run(uploader._preupload(page))
        sdk.assert_not_awaited()
        authorize.assert_not_called()

    def test_old_database_read_is_compatible_and_first_write_migrates(self):
        with closing(sqlite3.connect(self.database)) as db:
            db.execute('CREATE TABLE upload_cooldowns(account_id TEXT PRIMARY KEY, until_at REAL)')
            db.commit()
        self.assertFalse(self.status()['slow'])
        self.pacer().activate_slow('confirmed incident')
        self.assertTrue(self.status()['slow'])

    def test_burst_five_then_wait_and_restart_shares_slots(self):
        async def run():
            for index in range(5):
                await self.pacer().acquire(index+1)
            self.assertEqual(self.waits, [])
            await self.pacer().acquire(6)
        asyncio.run(run())
        starts = self.events('preupload_start')
        self.assertEqual([row[0] for row in starts[:5]], [1000]*5)
        self.assertEqual(starts[5][0], 1301)
        self.assertEqual(sum(self.waits), 301)
        self.assertTrue(all(wait <= 30 for wait in self.waits))
        self.assertEqual(self.pacer('other').reserve(1), 0)
        for index, start in enumerate(starts):
            self.assertLessEqual(sum(start[0]-300 < previous[0] <= start[0]
                                     for previous in starts[:index+1]), 5)

    def test_failure_consumes_slot_and_406_cooldown_survives_success(self):
        first = self.pacer()
        self.assertEqual(first.reserve(1), 0)
        first.record('preupload_failed', 'preupload', 406, 1)
        first.record('archive_complete', 'submit', 200)
        self.assertEqual(pacing.cooldown_remaining('one', self.database, now=self.now), 600)
        self.assertEqual(self.pacer().reserve(2), 600)
        self.assertEqual(len(self.events('preupload_start')), 1)
        asyncio.run(self.pacer().acquire(2))
        self.assertEqual(sum(self.waits), 600)
        self.assertEqual(pacing.cooldown_remaining('one', self.database, now=self.now), 0)
        for _ in range(4):
            self.assertEqual(self.pacer().reserve(1), 0)
            self.pacer().record('preupload_failed', 'preupload', 503, 1)
        self.assertGreater(self.pacer().reserve(1), 0)

    def test_atomic_reservations_across_concurrent_clients(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.pacer().reserve(1), range(16)))
        self.assertEqual(results.count(0), 5)
        self.assertEqual(len(self.events('preupload_start')), 5)
        self.assertTrue(all(result in (0, 301) for result in results))

    def test_actual_multipart_initializations_use_one_shared_account(self):
        pages = [object() for _ in range(7)]
        calls = []
        class SDK:
            async def _preupload(self, page):
                calls.append(page)
                return {'OK': 1}
        authorize = Mock()
        uploader = pacing.paced_uploader_type(SDK, self.pacer(), pages, authorize)()
        async def run():
            for page in pages:
                self.assertEqual(await uploader._preupload(page), {'OK': 1})
        asyncio.run(run())
        self.assertEqual(calls, pages)
        self.assertEqual(authorize.call_count, 7)
        self.assertEqual([row[1] for row in self.events('preupload_start')], list(range(1, 8)))
        self.assertEqual(sum(self.waits), 301)

    def test_sdk_406_stops_without_probe_or_internal_retry(self):
        from bilibili_api.exceptions import NetworkException
        calls = []
        page = object()
        class SDK:
            async def _preupload(self, page):
                calls.append(page)
                raise NetworkException(406, '')
        uploader = pacing.paced_uploader_type(SDK, self.pacer(), [page])()
        with self.assertRaises(pacing.PreuploadRateLimited):
            asyncio.run(uploader._preupload(page))
        self.assertEqual(calls, [page])
        self.assertEqual(self.events('preupload_failed')[0][2], 406)
        self.assertEqual(pacing.cooldown_remaining('one', self.database, now=self.now), 600)
        self.assertTrue(any('[RATE_LIMIT_406]' in line for line in self.logs))
        self.assertEqual(self.waits, [])

    def test_installed_sdk_real_initialization_406_is_captured(self):
        from bilibili_api import Picture, video_uploader
        page = Mock(path='P1.mp4', get_size=Mock(return_value=1000))
        credential = Mock(get_buvid_cookies=AsyncMock(return_value={}))
        meta = Mock(spec=video_uploader.VideoMeta, cover=Picture())
        uploader = pacing.paced_uploader_type(video_uploader.VideoUploader, self.pacer(), [page])(
            pages=[page], meta=meta, credential=credential, line=video_uploader.Lines.BDA2)
        uploader.line = {'os': 'upos', 'upcdn': 'bda2', 'probe_version': 20221109}
        client = Mock(request=AsyncMock(return_value=Mock(code=406)))
        with patch.object(video_uploader, 'get_client', return_value=client):
            with self.assertRaises(pacing.PreuploadRateLimited):
                asyncio.run(uploader._preupload(page))
        self.assertEqual(client.request.await_count, 1)
        self.assertEqual(client.request.call_args.kwargs['params']['name'], 'P1.mp4')
        self.assertEqual(pacing.cooldown_remaining('one', self.database, now=self.now), 600)

    def test_installed_sdk_chunk_406_escapes_internal_retry_without_logging_payload(self):
        from bilibili_api import Picture, video_uploader
        media = self.database.parent / 'test.mp4'
        media.write_bytes(b'test')
        page = video_uploader.VideoUploaderPage(path=str(media), title='P1')
        meta = Mock(spec=video_uploader.VideoMeta, cover=Picture())
        uploader = pacing.paced_uploader_type(video_uploader.VideoUploader, self.pacer(), [page])(
            pages=[page], meta=meta, credential=Mock(), line=video_uploader.Lines.BDA2)
        uploader.line = {'query': ''}
        client = Mock(request=AsyncMock(return_value=Mock(code=406)))
        preupload = {'chunk_size': 4, 'upload_id': 'private', 'auth': 'private',
                     'endpoint': '//example.test', 'upos_uri': 'upos://test.mp4'}
        with patch.object(video_uploader, 'get_client', return_value=client), \
                patch.object(uploader, '_switch_upload_endpoint', return_value=preupload), \
                patch.object(uploader, '_get_upload_url', return_value='https://example.test/upload'):
            with self.assertRaisesRegex(RuntimeError, 'chunk HTTP 406'):
                asyncio.run(uploader._upload_chunk(page, 0, 0, 1, preupload))
        self.assertEqual(client.request.await_count, 1)
        self.assertNotIn('private', ''.join(self.logs))

    def test_compatibility_cli_passes_account_pacer_to_actual_upload(self):
        from src.scripts import bilibili_upload
        submit = AsyncMock(return_value={'bvid': 'BVtest'})
        with patch.object(bilibili_upload.sys, 'argv', ['bilibili_upload.py', 'P1.mp4', '--title', 'title',
                                                       '--collection-series-id', '42']), \
                patch.object(bilibili_upload, 'build_credential', return_value=Mock(dedeuserid='one')), \
                patch('clip_upload_pacing.UploadPacing', return_value=self.pacer()) as make_pacer, \
                patch.object(bilibili_upload, 'upload_video', submit), redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as completed:
                bilibili_upload.main()
        self.assertEqual(completed.exception.code, 0)
        make_pacer.assert_called_once_with('one')
        self.assertEqual(submit.call_args.kwargs['pacing'].account_id, 'one')
        self.assertFalse(self.database.exists())

    def test_read_only_queries_do_not_create_files_and_logs_exclude_payloads(self):
        self.assertEqual(pacing.cooldown_remaining('one', self.database), 0)
        output = io.StringIO()
        with redirect_stdout(output):
            pacing.print_statistics(self.database)
        self.assertFalse(self.database.exists())
        output = io.StringIO()
        self.pacer().reserve(1)
        self.pacer().record('preupload_failed', 'preupload', 406, 1)
        with patch.object(pacing.time, 'time', return_value=self.now), redirect_stdout(output):
            pacing.print_statistics(self.database)
        data = json.loads(output.getvalue())
        self.assertEqual(data['windowLimit'], 5)
        self.assertEqual(len(data['recent']), 2)
        self.assertNotIn('cookie', ''.join(self.logs))
        self.assertIn('windowCounts', self.logs[0])


if __name__ == '__main__':
    unittest.main()
