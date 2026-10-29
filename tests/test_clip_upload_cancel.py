import asyncio
import unittest
from contextlib import contextmanager
from types import SimpleNamespace

from src.scripts.clip_upload_cancel import UploadCancelled, UploadControl


class UploadControlTests(unittest.IsolatedAsyncioTestCase):
    def control(self):
        job = {'id': 'job', 'status': 'running', 'clipIds': [1]}
        queue = {'jobs': [job]}
        registry = {'clips': {'1': {'mediaPath': 'video.mp4'}}}

        @contextmanager
        def transaction():
            yield queue

        api = SimpleNamespace(QUEUE_PATH='queue', REGISTRY_PATH='registry',
            default_queue=lambda: {}, default_registry=lambda: {},
            load_json=lambda file, default: queue if file == 'queue' else registry,
            find_queue_job=lambda value, job_id: job if job_id == job['id'] else None,
            paths_match=lambda a, b: a == b, queue_transaction=transaction)
        return UploadControl('job', 'video.mp4', api), job

    async def test_active_transfer_is_aborted_even_when_sdk_swallows_cancelled_error(self):
        control, job = self.control()
        started = asyncio.Event()

        class Uploader:
            aborted = False

            async def start(self):
                started.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    return None  # The installed SDK swallows cancellation in start().

            async def abort(self):
                self.aborted = True

        class Progress:
            async def run(self, uploader):
                return await uploader.start()

        uploader = Uploader()
        task = asyncio.create_task(control.run(uploader, Progress()))
        await started.wait()
        job['cancellationRequests'] = {'1': {'reason': '撤回'}}
        with self.assertRaises(UploadCancelled):
            await asyncio.wait_for(task, 2)
        self.assertTrue(uploader.aborted)
        self.assertNotIn('submissionStartedClipIds', job)

    async def test_cancellation_wins_before_irreversible_submit(self):
        control, job = self.control()

        class Base:
            submitted = False

            async def _submit(self):
                self.submitted = True

        uploader = control.uploader_type(Base)()
        job['cancellationRequests'] = {'1': {'reason': '撤回'}}
        with self.assertRaises(UploadCancelled):
            await uploader._submit()
        self.assertFalse(uploader.submitted)
        self.assertNotIn('submissionStartedClipIds', job)

    async def test_submit_gate_is_durable_and_known_rejection_releases_it(self):
        control, job = self.control()

        class Base:
            async def _submit(self):
                self.assert_started = job['submissionStartedClipIds'] == [1]
                return {'bvid': 'BV-test'}

        uploader = control.uploader_type(Base)()
        self.assertEqual(await uploader._submit(), {'bvid': 'BV-test'})
        self.assertTrue(uploader.assert_started)
        self.assertTrue(control.submitting)
        control.rejected()
        self.assertEqual(job['submissionStartedClipIds'], [])
