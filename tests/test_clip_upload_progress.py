import asyncio
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock
from bilibili_api.utils.AsyncEvent import AsyncEvent
from src.scripts.clip_upload_progress import UploadProgress, read_progress, progress_path
from src.scripts.clip_upload_status import show_clips, show_job_progress


class UploadProgressTests(unittest.TestCase):
    def test_failure_stage_and_request_events_exclude_sdk_payload(self):
        page = object()
        samples, events = [], []
        tracker = UploadProgress([page], 'movie.mp4', sink=samples.append,
                                 event_sink=lambda *args: events.append(args))
        class Uploader(AsyncEvent):
            async def start(self):
                self.dispatch('AFTER_PAGE', {'page': page, 'cookie': 'private'})
                self.dispatch('PRE_SUBMIT', {'cookie': 'private'})
                self.dispatch('SUBMIT_FAILED', {'cookie': 'private'})
                await asyncio.sleep(0)
                raise RuntimeError('406')
        with self.assertRaisesRegex(RuntimeError, '406'):
            asyncio.run(tracker.run(Uploader()))
        self.assertEqual(events, [('AFTER_PAGE', 1), ('PRE_SUBMIT', None)])
        self.assertEqual(samples[-1]['failureStage'], 'submitting')
        self.assertEqual(samples[-1]['lastEvent'], 'SUBMIT_FAILED')
        self.assertNotIn('private', json.dumps(samples))

    def test_out_of_order_retry_chunks_and_part_submit_are_not_archive_success(self):
        pages = [object(), object()]
        samples = []
        now = [0]
        tracker = UploadProgress(pages, 'movie.mp4', sink=samples.append, clock=lambda: now[0])
        def event(name, index=0, number=0):
            now[0] += 60
            tracker.event(name, {'page': pages[index], 'chunk_number': number, 'total_chunk_count': 4})
        event('PREUPLOAD')
        event('AFTER_CHUNK', number=3)
        event('AFTER_CHUNK', number=3)
        event('CHUNK_FAILED', number=0)
        self.assertEqual(samples[-1]['completedChunks'], 1)
        self.assertEqual(samples[-1]['partPercent'], 25)
        self.assertEqual(samples[-1]['overallPercent'], 12.5)
        event('AFTER_PAGE')
        self.assertEqual(samples[-1]['overallPercent'], 50)
        event('PREUPLOAD', 1)
        self.assertEqual(samples[-1]['partIndex'], 2)
        self.assertEqual(samples[-1]['partPercent'], 0)
        event('AFTER_PAGE', 1)
        now[0] += 60
        tracker.event('PRE_SUBMIT', {'cookie': 'never persist SDK payloads'})
        self.assertEqual(samples[-1]['overallPercent'], 100)
        self.assertEqual(samples[-1]['phase'], 'submitting')
        self.assertNotIn('cookie', json.dumps(samples))

    def test_real_sdk_dispatch_persists_and_query_exposes_live_progress(self):
        with tempfile.TemporaryDirectory() as folder:
            media = str(Path(folder) / 'P1.mp4')
            page = object()
            now = [0]
            class Uploader(AsyncEvent):
                async def start(self):
                    self.dispatch('PREUPLOAD', {'page': page})
                    self.dispatch('AFTER_CHUNK', {'page': page, 'chunk_number': 0, 'total_chunk_count': 2})
                    now[0] = 60
                    self.dispatch('PRE_PAGE_SUBMIT', {'page': page})
                    clip = {'id': 7, 'mediaPath': media}
                    self_observed = read_progress(clip)
                    self.assertion(self_observed)
                    self.dispatch('AFTER_PAGE', {'page': page})
                    self.dispatch('PRE_SUBMIT', {})
                    return {'bvid': 'BVtest'}
            uploader = Uploader()
            uploader.assertion = lambda value: self.assertEqual(value['partPercent'], 50)
            with contextlib.redirect_stdout(io.StringIO()):
                result = asyncio.run(UploadProgress([page], media, clock=lambda: now[0]).run(uploader))
            self.assertEqual(result['bvid'], 'BVtest')
            clip = {'id': 7, 'mediaPath': media}
            self.assertEqual(read_progress(clip)['phase'], 'completed')
            api = Mock()
            api.parse_int_list.return_value = [7]
            api.load_json.return_value = {'clips': {'7': clip}}
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                show_clips(Mock(ids='7'), api)
            self.assertEqual(json.loads(output.getvalue())['uploadProgress']['overallPercent'], 100)
            self.assertNotIn('uploadProgress', api.save_json.call_args.args[1]['clips']['7'])
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                show_job_progress({'clipIds': [7]}, {'clips': {'7': clip}})
            self.assertIn('P1/1 本P 100.0%', output.getvalue())

    def test_failure_retry_reset_and_throttling(self):
        page = object(); samples = []; now = [0]
        tracker = UploadProgress([page], 'movie.mp4', sink=samples.append, clock=lambda: now[0])
        class Uploader(AsyncEvent):
            async def start(self):
                self.dispatch('PRE_PAGE', {'page': page})
                for number in range(10):
                    self.dispatch('AFTER_CHUNK', {'page': page, 'chunk_number': number, 'total_chunk_count': 20})
                raise RuntimeError('403')
        with self.assertRaisesRegex(RuntimeError, '403'):
            asyncio.run(tracker.run(Uploader()))
        self.assertEqual(samples[-1]['phase'], 'failed')
        self.assertEqual(samples[-1]['partPercent'], 50)
        self.assertLess(len(samples), 6)
        tracker.event('AFTER_PAGE', {'page': page})
        self.assertEqual(samples[-1]['phase'], 'failed')
        retry = UploadProgress([page], 'movie.mp4', sink=samples.append)
        retry.emit(force=True)
        self.assertNotEqual(retry.run_id, tracker.run_id)
        self.assertEqual(samples[-1]['overallPercent'], 0)

    def test_stage_changes_and_retry_events_share_one_minute_limit(self):
        page = object(); samples = []; now = [0]
        tracker = UploadProgress([page], 'movie.mp4', sink=samples.append, clock=lambda: now[0])
        tracker.emit(force=True)
        for second in range(1, 121):
            now[0] = second
            for name in ('PREUPLOAD', 'PRE_PAGE', 'CHUNK_FAILED', 'AFTER_CHUNK', 'PRE_SUBMIT'):
                tracker.event(name, {'page': page, 'chunk_number': 0, 'total_chunk_count': 2})
            self.assertEqual(len(samples), 1 + second // 60)
        self.assertEqual(samples[-1]['partPercent'], 50)

    def test_missing_corrupt_and_old_attempt_progress(self):
        with tempfile.TemporaryDirectory() as folder:
            clip = {'mediaPath': str(Path(folder)/'P1.mp4'), 'updatedAt': '9999', 'status': 'uploading'}
            self.assertIsNone(read_progress(clip))
            progress_path(clip['mediaPath']).write_text('[]', encoding='utf-8')
            self.assertIsNone(read_progress(clip))
            progress_path(clip['mediaPath']).write_text('{', encoding='utf-8')
            self.assertIsNone(read_progress(clip))
            with contextlib.redirect_stdout(io.StringIO()):
                UploadProgress([object()], clip['mediaPath']).emit(force=True)
            self.assertTrue(read_progress(clip)['stale'])


if __name__ == '__main__':
    unittest.main()
