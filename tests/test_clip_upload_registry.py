import datetime as dt
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.scripts import clip_upload_registry as registry


class ClipUploadRegistryTests(unittest.TestCase):
    def test_queue_mutation_lock_rejects_overlapping_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime"
            runtime.mkdir(parents=True, exist_ok=True)
            queue_path = runtime / "queue.json"
            with patch.object(registry, "RUNTIME_DIR", runtime), patch.object(
                registry, "QUEUE_PATH", queue_path
            ):
                first = registry.acquire_queue_mutation_lock()
                try:
                    with self.assertRaises(registry.QueueLockTimeout):
                        registry.acquire_queue_mutation_lock(wait_seconds=0)
                finally:
                    registry.release_queue_mutation_lock(first)

    def test_submission_rate_limit_delay_doubles_from_twenty_minutes(self):
        self.assertEqual(registry.submission_rate_limit_delay_seconds(1), 20 * 60)
        self.assertEqual(registry.submission_rate_limit_delay_seconds(2), 40 * 60)
        self.assertEqual(registry.submission_rate_limit_delay_seconds(3), 80 * 60)
        self.assertEqual(
            registry.submission_rate_limit_delay_seconds(99),
            registry.SUBMISSION_RATE_LIMIT_MAX_DELAY_SECONDS,
        )

    def test_submission_rate_limit_detection_uses_exact_error_code(self):
        self.assertTrue(
            registry.is_bilibili_submission_rate_limit(
                "{'code': 137022, 'message': '投稿过于频繁，请稍后再试'}"
            )
        )
        self.assertFalse(
            registry.is_bilibili_submission_rate_limit(
                "member archives API 返回 code=-509: 请求过于频繁"
            )
        )
        self.assertFalse(registry.is_bilibili_submission_rate_limit("1370221"))

    def test_account_cooldown_blocks_all_pending_jobs(self):
        now = dt.datetime.now(dt.timezone.utc)
        queue = {
            "submissionRateLimit": {
                "cooldownUntil": (now + dt.timedelta(minutes=20)).isoformat()
            },
            "jobs": [{"id": "later", "status": "pending"}],
        }
        self.assertIsNone(registry.next_pending_job(queue))

        queue["submissionRateLimit"]["cooldownUntil"] = (
            now - dt.timedelta(seconds=1)
        ).isoformat()
        self.assertEqual(registry.next_pending_job(queue)["id"], "later")

    def test_rolling_upload_guard_releases_after_oldest_of_ninety_expires(self):
        now = dt.datetime(2026, 9, 3, 1, 0, tzinfo=dt.timezone.utc)
        oldest = now - dt.timedelta(hours=23)
        queue = {}
        state = registry.ensure_account_upload_guard(queue, "test-account")
        state["events"] = [
            {
                "at": (oldest + dt.timedelta(seconds=index)).isoformat(),
                "bvid": f"BV{index}",
            }
            for index in range(registry.ACCOUNT_ROLLING_UPLOAD_LIMIT)
        ]

        registry.recalculate_account_upload_guard(state, now)

        expected = oldest + dt.timedelta(
            seconds=(
                registry.ACCOUNT_ROLLING_WINDOW_SECONDS
                + registry.ACCOUNT_ROLLING_BOUNDARY_BUFFER_SECONDS
            )
        )
        self.assertEqual(state["recentCount"], 90)
        self.assertEqual(registry.account_upload_available_slots(state), 0)
        self.assertEqual(
            registry.parse_utc_timestamp(state["blockedUntil"]), expected
        )
        self.assertTrue(registry.account_upload_limit_active(queue, now))

    def test_normalizes_previously_imported_scored_media_paths(self):
        registry_data = {
            "clips": {
                "1": {
                    "mediaPath": r"D:\clips\clip.mp4 | 94分",
                },
                "2": {
                    "mediaPath": r"D:\clips\clip-2.mp4",
                },
            }
        }

        self.assertTrue(registry.normalize_registry_media_paths(registry_data))
        self.assertEqual(registry_data["clips"]["1"]["mediaPath"], r"D:\clips\clip.mp4")
        self.assertFalse(registry.normalize_registry_media_paths(registry_data))

    def test_review_parser_strips_score_from_media_path(self):
        with tempfile.TemporaryDirectory() as directory:
            review_path = Path(directory) / "REVIEW.md"
            review_path.write_text(
                "1. 测试标题 | 00:01:00 | 00:00:30 | "
                r"D:\clips\录制-25788785-20260828_fun_01.mp4 | 94分" "\n",
                encoding="utf-8",
            )

            parsed = registry.parse_review(review_path)

        self.assertEqual(
            parsed[0]["mediaPath"],
            r"D:\clips\录制-25788785-20260828_fun_01.mp4",
        )

    def test_json_manifest_supplies_upload_fields_without_review_parsing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            metadata_path = root / "clip.json"
            media_path = root / "clip.mp4"
            cover_path = root / "clip.jpg"
            metadata_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "roomId": "1820703922",
                        "streamerName": "花礼 Harei",
                        "recordedAt": "2026-08-28 20:00:00",
                        "streamTitle": "测试直播",
                        "upload": {
                            "source": "花礼 Harei 直播《测试直播》2026-08-28 20:00:00",
                            "prefix": "【小花】",
                            "tags": ["花礼 Harei", "#芙娅之魂", "AI切片"],
                            "tid": 21,
                            "roomId": "1820703922",
                            "streamerName": "花礼 Harei",
                        },
                        "window": {"start": 75, "duration": 90},
                        "copy": {"title": "结构化标题", "description": "结构化简介"},
                        "output": {
                            "mediaPath": str(media_path),
                            "metadataPath": str(metadata_path),
                            "coverPath": str(cover_path),
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            manifest_path = root / "UPLOAD_MANIFEST.json"
            manifest_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "type": "bilibili_clip_upload_manifest",
                        "reviewPath": str(root / "REVIEW.md"),
                        "clips": [{"reviewIndex": 3, "metadataPath": str(metadata_path)}],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            parsed = registry.load_upload_manifest(manifest_path)

        self.assertEqual(parsed[0]["reviewIndex"], 3)
        self.assertEqual(parsed[0]["title"], "结构化标题")
        self.assertEqual(parsed[0]["path"], str(media_path.resolve()))
        self.assertEqual(parsed[0]["metadataPath"], str(metadata_path.resolve()))
        self.assertEqual(parsed[0]["prefix"], "【小花】")
        self.assertEqual(parsed[0]["tags"], ["花礼 Harei", "#芙娅之魂", "AI切片"])
        self.assertEqual(parsed[0]["roomId"], "1820703922")

    def test_json_import_registers_manifest_and_does_not_need_review_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "runtime"
            registry_path = runtime / "registry.json"
            metadata_path = root / "clip.json"
            manifest_path = root / "UPLOAD_MANIFEST.json"
            media_path = root / "clip.mp4"
            metadata_path.write_text(
                json.dumps(
                    {
                        "upload": {
                            "source": "花礼 Harei 直播《测试》",
                            "prefix": "【小花】",
                            "tags": ["花礼 Harei", "#芙娅之魂"],
                            "roomId": "1820703922",
                            "streamerName": "花礼 Harei",
                        },
                        "window": {"start": 10, "duration": 30},
                        "copy": {"title": "JSON 标题", "description": "JSON 简介"},
                        "output": {
                            "mediaPath": str(media_path),
                            "metadataPath": str(metadata_path),
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            manifest_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "type": "bilibili_clip_upload_manifest",
                        "clips": [{"reviewIndex": 1, "metadataPath": str(metadata_path)}],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            args = type(
                "Args",
                (),
                {
                    "manifest": str(manifest_path),
                    "review": str(root / "missing-review.md"),
                    "source": "",
                    "tags": "",
                    "prefix": "",
                    "tid": 21,
                    "state": None,
                    "label": "",
                    "batch_id": "",
                },
            )()
            with patch.object(registry, "RUNTIME_DIR", runtime), patch.object(
                registry, "REGISTRY_PATH", registry_path
            ), patch.object(registry, "QUEUE_PATH", runtime / "clip_upload_queue.json"):
                self.assertEqual(registry.import_json(args), 0)
                saved = registry.load_json(registry_path, {})
                clip = saved["clips"]["1"]
                self.assertEqual(clip["sourceFormat"], "json")
                self.assertEqual(clip["manifestPath"], str(manifest_path.resolve()))
                self.assertEqual(clip["mediaPath"], str(media_path.resolve()))
                self.assertEqual(clip["tags"], ["花礼 Harei", "#芙娅之魂"])
                self.assertEqual(registry.validate_groups([[clip]]), [])

    def test_worker_uses_json_manifest_instead_of_review_path(self):
        clip = {
            "id": 1,
            "manifestPath": r"D:\clips\UPLOAD_MANIFEST.json",
            "reviewPath": r"D:\clips\missing-review.md",
            "statePath": r"D:\clips\upload_state.json",
            "source": "花礼 Harei 直播《测试》",
            "prefix": "【小花】",
            "tags": ["花礼 Harei", "#芙娅之魂"],
            "tid": 21,
            "reviewIndex": 1,
            "title": "JSON 标题",
            "mediaPath": r"D:\clips\clip.mp4",
            "roomId": "1820703922",
            "streamerName": "花礼 Harei",
        }
        job = {"id": "upload-test", "delay": 0, "rateLimitWait": 30, "rateLimitRetries": 1,
               "collectionSectionId": 9974272}
        completed = subprocess.CompletedProcess([], 0, stdout="uploaded")
        with patch.object(registry.subprocess, "run", return_value=completed) as run:
            result = registry.run_batch([clip], job)

        self.assertEqual(result.returncode, 0)
        command = run.call_args.args[0]
        self.assertIn("--manifest", command)
        self.assertIn(clip["manifestPath"], command)
        self.assertEqual(command[command.index("--queue-ids") + 1], "1")
        self.assertNotIn("--review", command)
        self.assertEqual(command[command.index("--collection-section-id") + 1], "9974272")

    def make_fixture(self, count=2):
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        root = Path(temp_dir.name)
        state_path = root / "upload_state.json"
        state_path.write_text(json.dumps({"done": {}, "got_406": {}}), encoding="utf-8")
        review_path = root / "REVIEW.md"
        review_path.write_text("", encoding="utf-8")

        clips = []
        for clip_id in range(1, count + 1):
            clips.append(
                {
                    "id": clip_id,
                    "status": "review",
                    "reviewPath": str(review_path),
                    "statePath": str(state_path),
                    "source": "测试直播",
                    "prefix": "【小岁】",
                    "tags": ["小岁"],
                    "tid": 21,
                    "reviewIndex": clip_id,
                    "title": f"测试标题 {clip_id}",
                    "mediaPath": str(root / f"clip-{clip_id}.mp4"),
                }
            )
        queue_job = {
            "id": "upload-test",
            "status": "pending",
            "clipIds": [clip["id"] for clip in clips],
            "delay": 0,
            "rateLimitWait": 30,
            "rateLimitRetries": 1,
        }
        registry_data = {"version": 1, "nextClipId": count + 1, "batches": {}, "clips": {}}
        registry_data["clips"] = {str(clip["id"]): clip for clip in clips}
        queue_data = {"version": 1, "jobs": [queue_job]}
        return {
            "root": root,
            "runtime": root / "runtime",
            "registry_path": root / "runtime" / "registry.json",
            "queue_path": root / "runtime" / "queue.json",
            "state_path": state_path,
            "clips": clips,
            "registry": registry_data,
            "queue": queue_data,
        }

    def test_406_stops_groups_and_waits_ten_minutes_without_generic_retry_limit(self):
        fixture = self.make_fixture(count=3)
        fixture['queue']['jobs'][0]['attempts'] = 30
        calls = []
        def run_batch(group, job):
            calls.append(group)
            return subprocess.CompletedProcess([], 75, stdout='[RATE_LIMIT_406] stage=preupload')
        before = dt.datetime.now(dt.timezone.utc)
        saved_registry, saved_queue = self.run_job_with(fixture, run_batch)
        job = saved_queue['jobs'][0]
        self.assertEqual(len(calls), 1)
        self.assertEqual(job['status'], 'retry_wait')
        self.assertEqual(job['retryKind'], 'bilibili_http_406')
        self.assertEqual(job['http406Attempts'], 1)
        self.assertEqual(job['attempts'], 31)
        self.assertGreaterEqual(dt.datetime.fromisoformat(job['retryAt']), before + dt.timedelta(seconds=600))
        self.assertTrue(all(clip['status'] == 'queued' for clip in saved_registry['clips'].values()))
        self.assertNotIn('submissionRateLimit', saved_queue)

    def test_406_gate_blocks_account_before_remote_guard_or_upload(self):
        from src.scripts.clip_upload_pacing import UploadPacing
        fixture = self.make_fixture()
        database = fixture['queue_path'].with_name(registry.clip_upload_pacing.DATABASE_NAME)
        UploadPacing('test-account', database, emit=lambda _: None).record('preupload_failed', 'preupload', 406)
        with patch.object(registry.clip_upload_state, 'load_worker_snapshot', return_value=(fixture['registry'], fixture['queue'])), \
                patch.object(registry, 'QUEUE_PATH', fixture['queue_path']), \
                patch.object(registry, 'configured_upload_account', return_value=('test-account', '', '')), \
                patch.object(registry, 'refresh_account_upload_guard') as guard, \
                patch.object(registry, 'run_batch') as upload:
            self.assertFalse(registry.run_one_job())
        guard.assert_not_called()
        upload.assert_not_called()

    def test_slow_mode_one_archive_then_yields_queue_without_counting_an_error(self):
        fixture = self.make_fixture(count=3)
        database = fixture['queue_path'].with_name(registry.clip_upload_pacing.DATABASE_NAME)
        pacer = registry.clip_upload_pacing.UploadPacing('test-account', database, emit=lambda _: None)
        pacer.activate_slow('confirmed incident')
        calls = []
        def run_batch(group, job):
            calls.append([clip['id'] for clip in group])
            self.assertEqual(pacer.reserve(1), 0)
            pacer.record('archive_complete', 'submit', 200)
            self.write_done(fixture, [1])
            return subprocess.CompletedProcess([], 0, stdout='uploaded')
        saved_registry, saved_queue = self.run_job_with(fixture, run_batch)
        self.assertEqual(calls, [[1]])
        job = saved_queue['jobs'][0]
        self.assertEqual(job['retryKind'], 'bilibili_upload_slow')
        self.assertEqual(job['status'], 'retry_wait')
        self.assertNotIn('attempts', job)
        self.assertEqual(saved_registry['clips']['1']['status'], 'uploaded')
        self.assertEqual(saved_registry['clips']['2']['status'], 'queued')

    def test_406_in_slow_mode_pauses_every_job_persistently_and_notifies(self):
        fixture = self.make_fixture(count=3)
        database = fixture['queue_path'].with_name(registry.clip_upload_pacing.DATABASE_NAME)
        pacer = registry.clip_upload_pacing.UploadPacing('test-account', database, emit=lambda _: None)
        pacer.activate_slow('confirmed incident')
        calls = []
        def run_batch(group, job):
            calls.append(group)
            pacer.reserve(1)
            pacer.record('preupload_failed', 'preupload', 406, 1)
            return subprocess.CompletedProcess([], 75, stdout='[RATE_LIMIT_406] stage=preupload')
        _, saved_queue = self.run_job_with(fixture, run_batch)
        self.assertEqual(len(calls), 1)
        job = saved_queue['jobs'][0]
        self.assertEqual(job['retryKind'], 'bilibili_upload_paused')
        self.assertNotIn('retryAt', job)
        with patch.object(registry.clip_upload_state, 'load_worker_snapshot', return_value=(fixture['registry'], saved_queue)), \
                patch.object(registry, 'QUEUE_PATH', fixture['queue_path']), \
                patch.object(registry, 'configured_upload_account', return_value=('test-account', '', '')), \
                patch.object(registry.clip_upload_retry, 'send_safety_notification', return_value=True) as notify, \
                patch.object(registry, 'refresh_account_upload_guard') as guard, \
                patch.object(registry, 'run_batch') as upload:
            self.assertFalse(registry.run_one_job())
            self.assertFalse(registry.run_one_job())
        # The earlier slow alert already has a five-minute retry deadline;
        # the newly created pause alert is delivered immediately, once.
        self.assertEqual(notify.call_count, 1)
        self.assertIn('等待人工处理', notify.call_args.args[1])
        guard.assert_not_called()
        upload.assert_not_called()

    def test_manual_resume_releases_safety_pause_but_keeps_24h_slow_mode(self):
        fixture = self.make_fixture(count=1)
        database = fixture['queue_path'].with_name(registry.clip_upload_pacing.DATABASE_NAME)
        pacer = registry.clip_upload_pacing.UploadPacing('test-account', database, emit=lambda _: None)
        pacer.activate_slow('confirmed incident')
        pacer.record('preupload_failed', 'preupload', 406, 1)
        fixture['queue']['jobs'][0].update(status='retry_wait', retryKind='bilibili_upload_paused',
                                         lastOutput='[UPLOAD_PAUSED]')
        registry.save_json(fixture['queue_path'], fixture['queue'])
        with patch.object(registry, 'RUNTIME_DIR', fixture['runtime']), \
                patch.object(registry, 'QUEUE_PATH', fixture['queue_path']), \
                patch.object(registry, 'configured_upload_account', return_value=('test-account', '', '')), \
                patch.object(registry, 'acquire_lock', return_value=True), patch.object(registry, 'release_lock'):
            self.assertEqual(registry.resume_uploads(type('Args', (), {'note': 'manual investigation complete'})()), 0)
        status = registry.clip_upload_pacing.protection_status('test-account', database)
        self.assertFalse(status['paused'])
        self.assertTrue(status['slow'])
        job = registry.load_json(fixture['queue_path'], {})['jobs'][0]
        self.assertEqual(job['status'], 'pending')
        self.assertNotIn('retryKind', job)

    def test_406_stops_mixed_routes_and_legacy_delay_is_zero(self):
        fixture = self.make_fixture()
        fixture['clips'][0]['manifestPath'] = str(fixture['root'] / 'manifest.json')
        fixture['queue']['jobs'][0]['delay'] = 60
        result = subprocess.CompletedProcess([], 0, stdout='[RATE_LIMIT_406] stage=preupload')
        with patch.object(registry.subprocess, 'run', return_value=result) as run, \
                patch.object(registry, '_clip_in_review', return_value=True):
            completed = registry.run_batch(fixture['clips'], fixture['queue']['jobs'][0])
        self.assertIn('[RATE_LIMIT_406]', completed.stdout)
        self.assertEqual(run.call_count, 1)
        command = run.call_args.args[0]
        self.assertEqual(command[command.index('--delay')+1], '0')

    def write_done(self, fixture, clip_ids):
        state = {"done": {}, "got_406": {}}
        for clip_id in clip_ids:
            clip = fixture["clips"][clip_id - 1]
            state["done"][str(clip_id)] = {
                "title": f"{clip['prefix']}{clip['title']}",
                "bvid": f"BV1TEST{clip_id}",
                "mediaPath": clip["mediaPath"],
            }
        fixture["state_path"].write_text(
            json.dumps(state, ensure_ascii=False), encoding="utf-8"
        )

    def run_job_with(self, fixture, run_batch):
        fixture["runtime"].mkdir(parents=True, exist_ok=True)
        registry.save_json(fixture["registry_path"], fixture["registry"])
        registry.save_json(fixture["queue_path"], fixture["queue"])

        def refresh_guard(queue, registry_data, now=None, force_remote=False):
            state = registry.ensure_account_upload_guard(queue, "test-account")
            registry.recalculate_account_upload_guard(state, now)
            return state, True

        with patch.object(registry, "RUNTIME_DIR", fixture["runtime"]), patch.object(
            registry, "REGISTRY_PATH", fixture["registry_path"]
        ), patch.object(registry, "QUEUE_PATH", fixture["queue_path"]), patch.object(
            registry,
            "grouped_clips",
            side_effect=lambda registry_data, ids: [
                [registry_data["clips"][str(clip_id)] for clip_id in ids]
            ],
        ), patch.object(registry, "validate_groups", return_value=[]), patch.object(
            registry, "run_batch", side_effect=run_batch
        ), patch.object(
            registry, "configured_upload_account", return_value=("test-account", "", "")
        ), patch.object(
            registry, "refresh_account_upload_guard", side_effect=refresh_guard
        ):
            self.assertTrue(registry.run_one_job())
        return (
            registry.load_json(fixture["registry_path"], {}),
            registry.load_json(fixture["queue_path"], {}),
        )

    def test_worker_preserves_job_enqueued_while_upload_is_running(self):
        fixture = self.make_fixture(count=2)
        fixture["queue"]["jobs"][0]["clipIds"] = [1]
        enqueue_args = type(
            "Args",
            (),
            {
                "ids": "2",
                "force": False,
                "dry_run": False,
                "delay": 0,
                "rate_limit_wait": 30,
                "rate_limit_retries": 1,
                "note": "concurrent enqueue",
            },
        )()

        def run_batch(group, job):
            self.assertEqual([clip["id"] for clip in group], [1])
            self.assertEqual(registry.enqueue(enqueue_args), 0)
            with registry.queue_transaction() as current_queue:
                current_queue["concurrentMetadata"] = {
                    "source": "enqueue",
                    "preserve": True,
                }
            self.write_done(fixture, [1])
            return subprocess.CompletedProcess([], 0, stdout="uploaded")

        saved_registry, saved_queue = self.run_job_with(fixture, run_batch)
        jobs = {job["id"]: job for job in saved_queue["jobs"]}
        concurrent_jobs = [job for job in saved_queue["jobs"] if job["id"] != "upload-test"]

        self.assertEqual(jobs["upload-test"]["status"], "done")
        self.assertEqual(len(concurrent_jobs), 1)
        self.assertEqual(concurrent_jobs[0]["clipIds"], [2])
        self.assertEqual(concurrent_jobs[0]["status"], "pending")
        self.assertEqual(saved_registry["clips"]["2"]["status"], "queued")
        self.assertEqual(
            saved_queue["concurrentMetadata"],
            {"source": "enqueue", "preserve": True},
        )

    def test_partial_success_requeues_only_unfinished_clips(self):
        fixture = self.make_fixture()

        def run_batch(group, job):
            self.write_done(fixture, [1])
            return subprocess.CompletedProcess(
                [], 1, stdout="network connection reset after first upload"
            )

        saved_registry, saved_queue = self.run_job_with(fixture, run_batch)
        self.assertEqual(saved_registry["clips"]["1"]["status"], "uploaded")
        self.assertEqual(saved_registry["clips"]["2"]["status"], "queued")
        self.assertEqual(saved_queue["jobs"][0]["status"], "retry_wait")
        self.assertEqual(saved_queue["jobs"][0]["clipStatuses"]["1"], "uploaded")
        self.assertEqual(saved_queue["jobs"][0]["clipStatuses"]["2"], "queued")

    def test_unknown_submission_waits_then_retries_only_unfinished_clips(self):
        fixture = self.make_fixture()
        intent = {"title": "【小岁】测试标题 2", "mediaPath": fixture["clips"][1]["mediaPath"],
                  "startedAt": registry.now_iso()}

        def run_batch(group, job):
            self.write_done(fixture, [1])
            state = registry.load_json(fixture["state_path"], {})
            state["submission_intents"] = {"2": intent}
            registry.save_json(fixture["state_path"], state)
            return subprocess.CompletedProcess([], 2, stdout=(
                "[STOP] automatic submission outcome unknown; reconcile the existing attempt before retrying"))

        saved_registry, saved_queue = self.run_job_with(fixture, run_batch)
        self.assertEqual(saved_registry["clips"]["1"]["status"], "uploaded")
        self.assertEqual(saved_registry["clips"]["2"]["status"], "queued")
        job = saved_queue["jobs"][0]
        self.assertEqual(job["status"], "retry_wait")
        self.assertEqual(job["attempts"], 1)
        retry_at = registry.parse_utc_timestamp(job["retryAt"])
        self.assertGreaterEqual((retry_at - registry.parse_utc_timestamp(intent["startedAt"])).total_seconds(), 300)
        self.assertIsNone(registry.next_pending_job(saved_queue))
        self.assertEqual(registry.load_json(fixture["state_path"], {})["submission_intents"], {"2": intent})

        # A later worker tick keeps the original ID/intent and skips the success.
        job["retryAt"] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)).isoformat()
        fixture.update(registry=saved_registry, queue=saved_queue)

        def retry_batch(group, job):
            self.assertEqual([clip["id"] for clip in group], [2])
            self.assertEqual(registry.load_json(fixture["state_path"], {})["submission_intents"], {"2": intent})
            self.write_done(fixture, [1, 2])
            return subprocess.CompletedProcess([], 0, stdout="reconciled and uploaded")

        saved_registry, saved_queue = self.run_job_with(fixture, retry_batch)
        self.assertEqual(saved_queue["jobs"][0]["status"], "done")
        self.assertTrue(all(clip["status"] == "uploaded" for clip in saved_registry["clips"].values()))

    def test_source_overlap_blocks_enqueue_and_worker_preflight_even_with_force(self):
        fixture = self.make_fixture()
        old, new = fixture['clips']
        for clip in (old, new):
            clip.update(sourceMediaPath='source.flv', start=100, duration=100,
                        manifestPath='manifest.json')
        old.update(status='uploaded', uploadState={'bvid': 'BVOLD'})
        new.update(start=120, duration=80, title='A changed title')
        fixture['runtime'].mkdir(parents=True)
        registry.save_json(fixture['registry_path'], fixture['registry'])
        registry.save_json(fixture['queue_path'], {'jobs': []})
        with patch.object(registry, 'RUNTIME_DIR', fixture['runtime']), \
                patch.object(registry, 'REGISTRY_PATH', fixture['registry_path']), \
                patch.object(registry, 'QUEUE_PATH', fixture['queue_path']), \
                patch.object(registry, 'validate_registry_qa', return_value=[]):
            args = registry.build_parser().parse_args(['enqueue', '--ids', '2', '--force'])
            self.assertEqual(registry.enqueue(args), 2)
            errors = registry.validate_groups([[new]])
            self.assertTrue(any('duplicate source content' in error for error in errors))
        self.assertEqual(json.loads(fixture['queue_path'].read_text())['jobs'], [])

    def test_137022_sets_account_cooldown_even_after_many_generic_retries(self):
        fixture = self.make_fixture(count=1)
        fixture["queue"]["jobs"][0]["attempts"] = (
            registry.MAX_AUTOMATIC_JOB_RETRIES + 3
        )
        fixture["queue"]["jobs"].append(
            {"id": "later", "status": "pending", "clipIds": []}
        )

        def run_batch(group, job):
            return subprocess.CompletedProcess(
                [],
                75,
                stdout=(
                    "接口返回错误代码：137022，信息：投稿过于频繁，请稍后再试。\n"
                    "{'code': 137022, 'message': '投稿过于频繁，请稍后再试'}"
                ),
            )

        saved_registry, saved_queue = self.run_job_with(fixture, run_batch)
        job = saved_queue["jobs"][0]
        cooldown = saved_queue["submissionRateLimit"]
        self.assertEqual(saved_registry["clips"]["1"]["status"], "queued")
        self.assertEqual(job["status"], "retry_wait")
        self.assertEqual(job["submissionRateLimitAttempts"], 1)
        self.assertEqual(cooldown["code"], 137022)
        self.assertEqual(cooldown["streak"], 1)
        self.assertEqual(cooldown["delaySeconds"], 20 * 60)
        self.assertEqual(job["retryAt"], cooldown["cooldownUntil"])
        self.assertIsNone(registry.next_pending_job(saved_queue))

    def test_repeated_137022_doubles_the_account_cooldown(self):
        fixture = self.make_fixture(count=1)
        job = fixture["queue"]["jobs"][0]

        registry.schedule_submission_rate_limit_retry(
            fixture["registry"],
            fixture["queue"],
            job,
            [1],
            "接口返回错误代码：137022",
        )
        registry.schedule_submission_rate_limit_retry(
            fixture["registry"],
            fixture["queue"],
            job,
            [1],
            "接口返回错误代码：137022",
        )

        cooldown = fixture["queue"]["submissionRateLimit"]
        self.assertEqual(cooldown["streak"], 2)
        self.assertEqual(cooldown["delaySeconds"], 40 * 60)
        self.assertEqual(job["submissionRateLimitAttempts"], 2)

    def test_success_clears_expired_account_rate_limit_streak(self):
        fixture = self.make_fixture(count=1)
        fixture["queue"]["submissionRateLimit"] = {
            "code": 137022,
            "streak": 3,
            "delaySeconds": 80 * 60,
            "cooldownUntil": (
                dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)
            ).isoformat(),
        }

        def run_batch(group, job):
            self.write_done(fixture, [1])
            return subprocess.CompletedProcess([], 0, stdout="uploaded")

        _, saved_queue = self.run_job_with(fixture, run_batch)
        self.assertEqual(saved_queue["jobs"][0]["status"], "done")
        self.assertNotIn("submissionRateLimit", saved_queue)

    def test_timeout_with_zero_title_conflicts_is_retryable(self):
        fixture = self.make_fixture()

        def run_batch(group, job):
            self.write_done(fixture, [1])
            return subprocess.CompletedProcess(
                [],
                124,
                stdout="[INFO] 同标题冲突(待核对): 0\n[worker] batch timed out after 1800s",
            )

        saved_registry, saved_queue = self.run_job_with(fixture, run_batch)
        self.assertEqual(saved_registry["clips"]["1"]["status"], "uploaded")
        self.assertEqual(saved_registry["clips"]["2"]["status"], "queued")
        self.assertEqual(saved_queue["jobs"][0]["status"], "retry_wait")
        self.assertNotIn("failureReason", saved_registry["clips"]["2"])

    def test_large_review_group_is_split_in_order(self):
        fixture = self.make_fixture(count=5)
        fixture["queue"]["jobs"][0]["batchSize"] = 2
        calls = []

        def run_batch(group, job):
            ids = [clip["id"] for clip in group]
            calls.append(ids)
            self.write_done(fixture, ids)
            return subprocess.CompletedProcess([], 0, stdout="uploaded")

        saved_registry, saved_queue = self.run_job_with(fixture, run_batch)
        self.assertEqual(calls, [[1, 2], [3, 4], [5]])
        self.assertTrue(
            all(
                clip["status"] == "uploaded"
                for clip in saved_registry["clips"].values()
            )
        )
        self.assertEqual(saved_queue["jobs"][0]["status"], "done")

    def test_137022_stops_later_upload_groups_immediately(self):
        fixture = self.make_fixture(count=5)
        fixture["queue"]["jobs"][0]["batchSize"] = 2
        calls = []

        def run_batch(group, job):
            calls.append([clip["id"] for clip in group])
            return subprocess.CompletedProcess(
                [], 75, stdout="接口返回错误代码：137022"
            )

        saved_registry, saved_queue = self.run_job_with(fixture, run_batch)
        self.assertEqual(calls, [[1, 2]])
        self.assertTrue(
            all(
                clip["status"] == "queued"
                for clip in saved_registry["clips"].values()
            )
        )
        self.assertEqual(saved_queue["jobs"][0]["status"], "retry_wait")

    def test_rolling_guard_allows_only_remaining_slot_then_notifies(self):
        fixture = self.make_fixture(count=3)
        now = dt.datetime.now(dt.timezone.utc)
        fixture["queue"]["accountRollingUploadGuard"] = {
            "accountId": "test-account",
            "limit": registry.ACCOUNT_ROLLING_UPLOAD_LIMIT,
            "windowSeconds": registry.ACCOUNT_ROLLING_WINDOW_SECONDS,
            "events": [
                {
                    "at": (now - dt.timedelta(hours=1) + dt.timedelta(seconds=index)).isoformat(),
                    "bvid": f"BV-previous-{index}",
                }
                for index in range(registry.ACCOUNT_ROLLING_UPLOAD_LIMIT - 1)
            ],
        }
        calls = []

        def run_batch(group, job):
            ids = [clip["id"] for clip in group]
            calls.append(ids)
            self.write_done(fixture, ids)
            return subprocess.CompletedProcess([], 0, stdout="uploaded")

        with patch.object(
            registry, "send_account_upload_limit_notification", return_value=True
        ) as notify:
            saved_registry, saved_queue = self.run_job_with(fixture, run_batch)

        job = saved_queue["jobs"][0]
        guard = saved_queue["accountRollingUploadGuard"]
        self.assertEqual(calls, [[1]])
        self.assertEqual(saved_registry["clips"]["1"]["status"], "uploaded")
        self.assertEqual(saved_registry["clips"]["2"]["status"], "queued")
        self.assertEqual(saved_registry["clips"]["3"]["status"], "queued")
        self.assertEqual(guard["recentCount"], 90)
        self.assertEqual(job["status"], "retry_wait")
        self.assertEqual(job["retryKind"], "account_rolling_upload_limit")
        self.assertEqual(job["retryAt"], guard["blockedUntil"])
        notify.assert_called_once()

    def test_terminal_missing_file_does_not_retry_forever(self):
        fixture = self.make_fixture(count=1)

        def run_batch(group, job):
            return subprocess.CompletedProcess(
                [], 1, stdout="[ERROR] 视频文件不存在: clip-1.mp4\n文件缺失: 1"
            )

        saved_registry, saved_queue = self.run_job_with(fixture, run_batch)
        clip = saved_registry["clips"]["1"]
        self.assertEqual(clip["status"], "failed")
        self.assertIn("deterministic uploader error", clip["failureReason"])
        self.assertEqual(saved_queue["jobs"][0]["status"], "failed")

    def test_unknown_submission_waits_for_reconciliation_and_continues_other_groups(self):
        fixture = self.make_fixture(count=3)
        fixture["queue"]["jobs"][0]["batchSize"] = 1
        calls = []

        def run_batch(group, job):
            ids = [clip["id"] for clip in group]
            calls.append(ids)
            if ids == [1]:
                return subprocess.CompletedProcess([], 2, stdout="[WAIT] automatic submission outcome unknown")
            self.write_done(fixture, [2, 3] if ids == [3] else [2])
            return subprocess.CompletedProcess([], 0, stdout="uploaded" + "x" * 13000)

        saved_registry, saved_queue = self.run_job_with(fixture, run_batch)
        self.assertEqual(calls, [[1], [2], [3]])
        self.assertEqual(saved_registry["clips"]["2"]["status"], "uploaded")
        self.assertEqual(saved_registry["clips"]["3"]["status"], "uploaded")
        self.assertEqual(saved_registry["clips"]["1"]["status"], "queued")
        self.assertEqual(saved_queue["jobs"][0]["status"], "retry_wait")
        self.assertIn("retryAt", saved_queue["jobs"][0])

    def test_submission_recovery_conflicts_remain_terminal(self):
        for reason in ("submission recovery conflict: title exists online",
                       "submission recovery authorization invalid: public copy changed"):
            with self.subTest(reason=reason):
                fixture = self.make_fixture(count=2)
                fixture["queue"]["jobs"][0]["batchSize"] = 1
                calls = []

                def run_batch(group, job):
                    calls.append([clip["id"] for clip in group])
                    return subprocess.CompletedProcess([], 2, stdout=f"[WAIT] submission outcome unknown\n[STOP] {reason}")

                saved_registry, saved_queue = self.run_job_with(fixture, run_batch)
                self.assertEqual(calls, [[1]])
                self.assertEqual(saved_queue["jobs"][0]["status"], "failed")
                self.assertNotIn("retryAt", saved_queue["jobs"][0])
                self.assertEqual(saved_registry["clips"]["1"]["status"], "failed")

    def test_all_state_success_wins_over_subprocess_exit_code(self):
        fixture = self.make_fixture()

        def run_batch(group, job):
            self.write_done(fixture, [1, 2])
            return subprocess.CompletedProcess(
                [], 1, stdout="collection attachment failed after upload"
            )

        saved_registry, saved_queue = self.run_job_with(fixture, run_batch)
        self.assertTrue(
            all(clip["status"] == "uploaded" for clip in saved_registry["clips"].values())
        )
        self.assertEqual(saved_queue["jobs"][0]["status"], "done")

    def test_retry_limit_blocks_remaining_clips(self):
        fixture = self.make_fixture(count=1)
        job = fixture["queue"]["jobs"][0]
        job["attempts"] = registry.MAX_AUTOMATIC_JOB_RETRIES - 1
        result = registry.schedule_retry_or_block(
            fixture["registry"], job, [1], "temporary error", "network failure"
        )
        self.assertEqual(result, "blocked")
        self.assertEqual(fixture["registry"]["clips"]["1"]["status"], "failed")
        self.assertEqual(job["status"], "blocked")

    def test_worker_recovery_requeues_interrupted_running_job(self):
        fixture = self.make_fixture(count=1)
        fixture["queue"]["jobs"][0]["status"] = "running"
        fixture["registry"]["clips"]["1"]["status"] = "uploading"
        fixture["runtime"].mkdir(parents=True, exist_ok=True)
        registry.save_json(fixture["registry_path"], fixture["registry"])
        registry.save_json(fixture["queue_path"], fixture["queue"])
        with patch.object(registry, "RUNTIME_DIR", fixture["runtime"]), patch.object(
            registry, "REGISTRY_PATH", fixture["registry_path"]
        ), patch.object(registry, "QUEUE_PATH", fixture["queue_path"]):
            self.assertTrue(registry.recover_interrupted_jobs())

        saved_registry = registry.load_json(fixture["registry_path"], {})
        saved_queue = registry.load_json(fixture["queue_path"], {})
        self.assertEqual(saved_registry["clips"]["1"]["status"], "queued")
        self.assertEqual(saved_queue["jobs"][0]["status"], "pending")

    def test_worker_recovery_restores_cooldown_from_existing_137022_output(self):
        fixture = self.make_fixture(count=1)
        job = fixture["queue"]["jobs"][0]
        job["status"] = "running"
        job["lastOutput"] = "接口返回错误代码：137022"
        fixture["registry"]["clips"]["1"]["status"] = "uploading"
        fixture["runtime"].mkdir(parents=True, exist_ok=True)
        registry.save_json(fixture["registry_path"], fixture["registry"])
        registry.save_json(fixture["queue_path"], fixture["queue"])
        with patch.object(registry, "RUNTIME_DIR", fixture["runtime"]), patch.object(
            registry, "REGISTRY_PATH", fixture["registry_path"]
        ), patch.object(registry, "QUEUE_PATH", fixture["queue_path"]):
            self.assertTrue(registry.recover_interrupted_jobs())

        saved_queue = registry.load_json(fixture["queue_path"], {})
        self.assertEqual(saved_queue["jobs"][0]["status"], "pending")
        self.assertEqual(
            saved_queue["submissionRateLimit"]["delaySeconds"], 20 * 60
        )
        self.assertIsNone(registry.next_pending_job(saved_queue))

    def test_recovery_closes_old_failed_job_when_state_is_complete(self):
        fixture = self.make_fixture(count=1)
        fixture["queue"]["jobs"][0]["status"] = "failed"
        fixture["registry"]["clips"]["1"]["status"] = "uploading"
        self.write_done(fixture, [1])
        fixture["runtime"].mkdir(parents=True, exist_ok=True)
        registry.save_json(fixture["registry_path"], fixture["registry"])
        registry.save_json(fixture["queue_path"], fixture["queue"])
        with patch.object(registry, "RUNTIME_DIR", fixture["runtime"]), patch.object(
            registry, "REGISTRY_PATH", fixture["registry_path"]
        ), patch.object(registry, "QUEUE_PATH", fixture["queue_path"]):
            self.assertTrue(registry.recover_interrupted_jobs())

        saved_registry = registry.load_json(fixture["registry_path"], {})
        saved_queue = registry.load_json(fixture["queue_path"], {})
        self.assertEqual(saved_registry["clips"]["1"]["status"], "uploaded")
        self.assertEqual(saved_queue["jobs"][0]["status"], "done")

    def test_zero_missing_file_summary_is_not_terminal(self):
        self.assertFalse(registry.has_terminal_upload_error("文件缺失: 0"))
        self.assertTrue(registry.has_terminal_upload_error("文件缺失: 1"))
        self.assertFalse(
            registry.has_terminal_upload_error("同标题冲突(待核对): 0")
        )
        self.assertTrue(
            registry.has_terminal_upload_error("同标题冲突(待核对): 1")
        )

    def test_manual_state_records_collection_result(self):
        fixture = self.make_fixture(count=1)
        registry._write_manual_state(
            fixture["state_path"],
            1,
            fixture["clips"][0],
            "  bvid: BV1ROUTING\n  aid: 12345\n  合集: 9974272 (ok)\n",
        )
        saved = json.loads(fixture["state_path"].read_text(encoding="utf-8"))
        self.assertEqual(saved["done"]["1"]["collectionSectionId"], 9974272)
        self.assertEqual(saved["done"]["1"]["collectionStatus"], "ok")

    def test_title_conflict_is_terminal_for_manual_review(self):
        self.assertTrue(registry.has_terminal_upload_error("同标题冲突: BV1CONFLICT"))

    def test_force_job_reuploads_clip_even_when_registry_says_uploaded(self):
        fixture = self.make_fixture(count=1)
        fixture["registry"]["clips"]["1"]["status"] = "uploaded"
        fixture["queue"]["jobs"][0]["allowDuplicateTitle"] = True

        calls = []

        def run_batch(group, job):
            calls.append(job.get("allowDuplicateTitle"))
            self.write_done(fixture, [1])
            return subprocess.CompletedProcess([], 0, stdout="uploaded replacement")

        self.run_job_with(fixture, run_batch)
        self.assertEqual(calls, [True])

    def test_force_enqueue_marks_job_and_clip_for_resubmission(self):
        fixture = self.make_fixture(count=1)
        fixture["runtime"].mkdir(parents=True, exist_ok=True)
        registry.save_json(fixture["registry_path"], fixture["registry"])
        with patch.object(registry, "RUNTIME_DIR", fixture["runtime"]), patch.object(
            registry, "REGISTRY_PATH", fixture["registry_path"]
        ), patch.object(registry, "QUEUE_PATH", fixture["queue_path"]):
            args = type(
                "Args",
                (),
                {
                    "ids": "1",
                    "force": True,
                    "dry_run": False,
                    "delay": 0,
                    "rate_limit_wait": 30,
                    "rate_limit_retries": 1,
                    "note": "authorized replacement",
                },
            )()
            self.assertEqual(registry.enqueue(args), 0)

        saved_registry = registry.load_json(fixture["registry_path"], {})
        saved_queue = registry.load_json(fixture["queue_path"], {})
        self.assertEqual(saved_registry["clips"]["1"]["status"], "queued")
        self.assertTrue(saved_queue["jobs"][-1]["allowDuplicateTitle"])

    def test_saved_web_title_blocks_recovery_enqueue_and_worker_until_applied_or_reset(self):
        fixture = self.make_fixture(count=1)
        fixture['runtime'].mkdir(parents=True)
        clip = fixture['clips'][0]
        metadata_path = fixture['root'] / 'clip.json'
        clip['metadataPath'] = str(metadata_path)
        registry.save_json(metadata_path, {'copy': {'title': clip['title']}})
        registry.save_json(fixture['registry_path'], fixture['registry'])
        choices_path = fixture['runtime'] / 'admin/title-choices/1.json'
        choices_path.parent.mkdir(parents=True)
        chosen = {'selection': {'title': '用户手写的新标题'},
                  'history': [{'at': '2026-01-01T01:00:00.000Z'}]}
        # A later read/refresh of changed evidence must not silently cancel intent.
        choices = {'sets': [chosen, {'selection': None, 'history': []}]}
        registry.save_json(choices_path, choices)
        args = type('Args', (), {'ids': '1', 'force': True, 'dry_run': False,
                                'delay': 0, 'rate_limit_wait': 30, 'rate_limit_retries': 1,
                                'note': 'recover failed Web feedback'})()
        with patch.object(registry, 'RUNTIME_DIR', fixture['runtime']), patch.object(
            registry, 'REGISTRY_PATH', fixture['registry_path']
        ), patch.object(registry, 'QUEUE_PATH', fixture['queue_path']):
            self.assertEqual(registry.enqueue(args), 2)
            self.assertFalse(fixture['queue_path'].exists())
            self.assertEqual(registry.load_json(fixture['registry_path'], {}), fixture['registry'])
            self.assertTrue(any('saved Web title' in error for error in registry.validate_groups([[clip]])))
            # Changing only the registry cannot conceal an old title in uploader metadata.
            clip['title'] = '用户手写的新标题'
            self.assertTrue(any('saved Web title' in error for error in registry.validate_groups([[clip]])))
            registry.save_json(metadata_path, {'copy': {'title': '【小岁】用户手写的新标题'}})
            self.assertEqual(registry.validate_groups([[clip]]), [])
            registry.save_json(fixture['registry_path'], fixture['registry'])
            self.assertEqual(registry.enqueue(args), 0)
            self.assertEqual(len(registry.load_json(fixture['queue_path'], {})['jobs']), 1)
            # An explicit reset is a new decision, unlike a fresh unselected set.
            choices['sets'].append({'selection': None, 'history': [{'at': '2026-01-01T02:00:00.000Z'}]})
            registry.save_json(choices_path, choices)
            clip['title'] = '另一个经过审核的标题'
            self.assertEqual(registry.validate_groups([[clip]]), [])

    def test_editorial_exclusion_cancels_only_selected_ids_and_blocks_force(self):
        fixture = self.make_fixture(count=2)
        fixture["runtime"].mkdir(parents=True, exist_ok=True)
        registry.save_json(fixture["registry_path"], fixture["registry"])
        registry.save_json(fixture["queue_path"], fixture["queue"])
        args = type("Args", (), {"ids": "1", "note": "streamer content restriction"})()
        with patch.object(registry, "RUNTIME_DIR", fixture["runtime"]), patch.object(
            registry, "REGISTRY_PATH", fixture["registry_path"]
        ), patch.object(registry, "QUEUE_PATH", fixture["queue_path"]), patch.object(
            registry, "acquire_lock", return_value=True
        ), patch.object(registry, "release_lock"):
            self.assertEqual(registry.exclude_clips(args), 0)
            saved = registry.load_json(fixture["registry_path"], {})
            queue = registry.load_json(fixture["queue_path"], {})
            self.assertEqual(saved["clips"]["1"]["status"], "cancelled")
            self.assertEqual(queue["jobs"][0]["clipIds"], [2])
            self.assertEqual(queue["jobs"][0]["status"], "pending")
            self.write_done(fixture, [1])
            registry.sync_clip_statuses(saved, [1])
            self.assertEqual(saved["clips"]["1"]["status"], "cancelled")
            upload = type("Args", (), {"ids": "1", "force": True, "dry_run": True})()
            self.assertEqual(registry.enqueue(upload), 2)
            self.assertTrue(any("editorially excluded" in e for e in registry.validate_groups([[saved["clips"]["1"]]])))
            args.ids = "2"
            self.assertEqual(registry.exclude_clips(args), 0)
            queue = registry.load_json(fixture["queue_path"], {})
            self.assertEqual(queue["jobs"][0]["status"], "cancelled")

    def test_cancel_one_running_clip_preserves_siblings_and_concurrent_enqueue(self):
        fixture = self.make_fixture(count=3)
        fixture['queue']['jobs'][0].update(clipIds=[1, 2], batchSize=1)
        seen = []

        def run_batch(group, job):
            seen.extend(c['id'] for c in group)
            if group[0]['id'] == 1:
                args = registry.build_parser().parse_args(['cancel', '--ids', '1', '--note', '人工撤回'])
                self.assertEqual(registry.cancel_job(args), 0)
                # The upload process still owns this ID until it has actually stopped.
                queue = registry.load_json(fixture['queue_path'], {})
                self.assertIn(1, registry.clip_candidate_queue.active_ids(queue))
                registry.enqueue(registry.build_parser().parse_args(['enqueue', '--ids', '3']))
                return subprocess.CompletedProcess([], 0, stdout='[UPLOAD_CANCELLED]')
            self.write_done(fixture, [2])
            return subprocess.CompletedProcess([], 0, stdout='ok')

        saved, queue = self.run_job_with(fixture, run_batch)
        self.assertEqual(seen, [1, 2])
        self.assertEqual(saved['clips']['1']['status'], 'review')
        self.assertEqual(saved['clips']['2']['status'], 'uploaded')
        self.assertEqual(saved['clips']['3']['status'], 'queued')
        self.assertEqual(queue['jobs'][0]['status'], 'done')
        self.assertEqual(queue['jobs'][0]['cancellationRequests']['1']['reason'], '人工撤回')
        self.assertNotIn(1, registry.clip_candidate_queue.active_ids(queue))
        self.assertEqual(queue['jobs'][-1]['clipIds'], [3])

    def test_cancel_entire_running_job_does_not_upload_later_groups(self):
        fixture = self.make_fixture(count=2)
        fixture['queue']['jobs'][0]['batchSize'] = 1
        seen = []

        def run_batch(group, job):
            seen.extend(c['id'] for c in group)
            self.assertEqual(registry.cancel_job(registry.build_parser().parse_args([
                'cancel', '--job', job['id'], '--note', '撤回整批'])), 0)
            return subprocess.CompletedProcess([], 0, stdout='[UPLOAD_CANCELLED]')

        saved, queue = self.run_job_with(fixture, run_batch)
        self.assertEqual(seen, [1])
        self.assertEqual(queue['jobs'][0]['status'], 'cancelled')
        self.assertTrue(all(c['status'] == 'review' for c in saved['clips'].values()))

    def test_stale_worker_snapshots_cannot_revive_cancelled_clip(self):
        fixture = self.make_fixture(count=2)

        def run_batch(group, job):
            snapshot = registry.load_json(fixture['registry_path'], {})
            stale_queue = registry.load_json(fixture['queue_path'], {})
            self.assertEqual(registry.cancel_job(registry.build_parser().parse_args([
                'cancel', '--ids', '1', '--note', '撤回'])), 0)
            registry.clip_upload_state.commit_worker_statuses(registry, snapshot, [1, 2])
            registry.commit_queue_snapshot(stale_queue, job_ids=[job['id']])
            self.assertEqual(registry.load_json(fixture['registry_path'], {})['clips']['1']['status'], 'cancelling')
            self.assertIn('1', registry.load_json(fixture['queue_path'], {})['jobs'][0]['cancellationRequests'])
            self.write_done(fixture, [2])
            return subprocess.CompletedProcess([], 0, stdout='ok')

        saved, _ = self.run_job_with(fixture, run_batch)
        self.assertEqual(saved['clips']['1']['status'], 'review')

    def test_cancel_rejects_started_submission_and_does_not_change_siblings(self):
        fixture = self.make_fixture(count=2)

        def run_batch(group, job):
            with registry.queue_transaction() as queue:
                queue['jobs'][0]['submissionStartedClipIds'] = [1]
            before = fixture['queue_path'].read_bytes()
            self.assertEqual(registry.cancel_job(registry.build_parser().parse_args([
                'cancel', '--job', job['id'], '--note', '太晚了'])), 2)
            self.assertEqual(fixture['queue_path'].read_bytes(), before)
            self.assertNotIn('uploadCancellation', registry.load_json(fixture['registry_path'], {})['clips']['2'])
            self.write_done(fixture, [1, 2])
            return subprocess.CompletedProcess([], 0, stdout='ok')

        saved, queue = self.run_job_with(fixture, run_batch)
        self.assertEqual(queue['jobs'][0]['status'], 'done')
        self.assertTrue(all(c['status'] == 'uploaded' for c in saved['clips'].values()))

    def test_cancelled_job_clips_can_be_enqueued_again(self):
        fixture = self.make_fixture(count=2)
        for clip in fixture["registry"]["clips"].values():
            clip["status"] = "queued"
        fixture["runtime"].mkdir(parents=True, exist_ok=True)
        registry.save_json(fixture["registry_path"], fixture["registry"])
        registry.save_json(fixture["queue_path"], fixture["queue"])

        cancel_args = type(
            "Args",
            (),
            {"job": "upload-test", "note": "defer ids 1-2"},
        )()
        enqueue_args = type(
            "Args",
            (),
            {
                "ids": "1,2",
                "force": False,
                "dry_run": False,
                "delay": 0,
                "rate_limit_wait": 30,
                "rate_limit_retries": 1,
                "note": "resume deferred clips",
            },
        )()
        with patch.object(registry, "RUNTIME_DIR", fixture["runtime"]), patch.object(
            registry, "REGISTRY_PATH", fixture["registry_path"]
        ), patch.object(registry, "QUEUE_PATH", fixture["queue_path"]), patch.object(
            registry, "LOCK_PATH", fixture["runtime"] / "worker.lock"
        ), patch.object(registry, "acquire_lock", return_value=True), patch.object(
            registry, "release_lock"
        ) as release_lock:
            self.assertEqual(registry.cancel_job(cancel_args), 0)
            cancelled_registry = registry.load_json(fixture["registry_path"], {})
            cancelled_queue = registry.load_json(fixture["queue_path"], {})
            self.assertEqual(cancelled_queue["jobs"][0]["status"], "cancelled")
            self.assertEqual(
                cancelled_queue["jobs"][0]["cancellationReason"],
                "defer ids 1-2",
            )
            self.assertTrue(
                all(
                    clip["status"] == "review"
                    for clip in cancelled_registry["clips"].values()
                )
            )
            self.assertEqual(registry.enqueue(enqueue_args), 0)
            release_lock.assert_not_called()

        resumed_registry = registry.load_json(fixture["registry_path"], {})
        resumed_queue = registry.load_json(fixture["queue_path"], {})
        self.assertTrue(
            all(clip["status"] == "queued" for clip in resumed_registry["clips"].values())
        )
        self.assertEqual(resumed_queue["jobs"][-1]["status"], "pending")
        self.assertEqual(resumed_queue["jobs"][-1]["clipIds"], [1, 2])

    def test_cancel_blocked_or_running_job_preserves_uploaded_clip(self):
        for status, expected in (("blocked", 0), ("running", 0)):
            with self.subTest(status=status):
                fixture = self.make_fixture(count=2)
                fixture["queue"]["jobs"][0].update(status=status, attempts=3,
                    retryAt="2026-08-23T00:00:00+08:00", error="retry limit reached")
                fixture["registry"]["clips"]["1"]["status"] = "needs_retry"
                fixture["registry"]["clips"]["2"].update(status="uploaded", bvid="BV-fixture")
                fixture["runtime"].mkdir(parents=True, exist_ok=True)
                registry.save_json(fixture["registry_path"], fixture["registry"])
                registry.save_json(fixture["queue_path"], fixture["queue"])
                args = type("Args", (), {"job": "upload-test", "note": "obsolete job"})()
                with patch.object(registry, "REGISTRY_PATH", fixture["registry_path"]), \
                     patch.object(registry, "QUEUE_PATH", fixture["queue_path"]), \
                     patch.object(registry, "RUNTIME_DIR", fixture["runtime"]), \
                     patch.object(registry, "acquire_lock", return_value=True), \
                     patch.object(registry, "release_lock"):
                    self.assertEqual(registry.cancel_job(args), expected)
                    saved = registry.load_json(fixture["queue_path"], {})["jobs"][0]
                    clips = registry.load_json(fixture["registry_path"], {})["clips"]
                    if status == "blocked":
                        self.assertEqual(saved["status"], "cancelled")
                        self.assertEqual(saved["cancellationReason"], "obsolete job")
                        self.assertNotIn("retryAt", saved)
                        self.assertEqual(clips["1"]["status"], "review")
                        self.assertEqual(registry.cancel_job(args), 0)
                    else:
                        self.assertEqual(saved["status"], "running")
                        self.assertEqual(clips["1"]["status"], "cancelling")
                        registry.clip_upload_cancel.acknowledge(registry, "upload-test", [1])
                        self.assertEqual(registry.load_json(fixture["queue_path"], {})["jobs"][0]["status"], "cancelled")
                    self.assertEqual(clips["2"]["status"], "uploaded")
                    self.assertEqual(clips["2"]["bvid"], "BV-fixture")

    def test_manual_resume_clears_cooldown_and_releases_rate_limited_jobs(self):
        fixture = self.make_fixture(count=1)
        rate_limited_job = fixture["queue"]["jobs"][0]
        rate_limited_job.update(
            {
                "status": "retry_wait",
                "retryAt": "2026-09-03T03:42:35+08:00",
                "retryKind": "bilibili_submission_rate_limit",
                "submissionRateLimitAttempts": 5,
                "error": "Bilibili submission rate limited (code 137022)",
                "lastOutput": "接口返回错误代码：137022",
            }
        )
        fixture["queue"]["submissionRateLimit"] = {
            "code": 137022,
            "streak": 7,
            "cooldownUntil": "2026-09-03T03:42:35+08:00",
        }
        fixture["queue"]["jobs"].append(
            {
                "id": "generic-retry",
                "status": "retry_wait",
                "retryAt": "2026-09-03T04:00:00+08:00",
                "retryKind": "network",
                "clipIds": [],
            }
        )
        fixture["runtime"].mkdir(parents=True, exist_ok=True)
        registry.save_json(fixture["registry_path"], fixture["registry"])
        registry.save_json(fixture["queue_path"], fixture["queue"])
        args = type("Args", (), {"note": "manual upload succeeded"})()

        with patch.object(registry, "RUNTIME_DIR", fixture["runtime"]), patch.object(
            registry, "REGISTRY_PATH", fixture["registry_path"]
        ), patch.object(
            registry, "QUEUE_PATH", fixture["queue_path"]
        ), patch.object(
            registry, "LOCK_PATH", fixture["runtime"] / "worker.lock"
        ), patch.object(registry, "acquire_lock", return_value=True), patch.object(
            registry, "release_lock"
        ) as release_lock:
            self.assertEqual(registry.resume_uploads(args), 0)
            release_lock.assert_called_once()

        saved_queue = registry.load_json(fixture["queue_path"], {})
        resumed_job = saved_queue["jobs"][0]
        self.assertNotIn("submissionRateLimit", saved_queue)
        self.assertEqual(resumed_job["status"], "pending")
        self.assertEqual(resumed_job["resumeReason"], "manual upload succeeded")
        self.assertEqual(resumed_job["previousSubmissionRateLimitAttempts"], 5)
        self.assertNotIn("retryAt", resumed_job)
        self.assertNotIn("retryKind", resumed_job)
        self.assertNotIn("submissionRateLimitAttempts", resumed_job)
        self.assertNotIn("lastOutput", resumed_job)
        self.assertIn("137022", resumed_job["previousRateLimitOutput"])
        self.assertEqual(saved_queue["jobs"][1]["status"], "retry_wait")
        self.assertEqual(saved_queue["lastManualResume"]["previousCooldown"]["streak"], 7)

        with patch.object(registry, "RUNTIME_DIR", fixture["runtime"]), patch.object(
            registry, "REGISTRY_PATH", fixture["registry_path"]
        ), patch.object(registry, "QUEUE_PATH", fixture["queue_path"]):
            registry.recover_interrupted_jobs()
        recovered_queue = registry.load_json(fixture["queue_path"], {})
        self.assertNotIn("submissionRateLimit", recovered_queue)


if __name__ == "__main__":
    unittest.main()
