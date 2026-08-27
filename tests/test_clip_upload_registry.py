import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.scripts import clip_upload_registry as registry


class ClipUploadRegistryTests(unittest.TestCase):
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
        with patch.object(registry, "RUNTIME_DIR", fixture["runtime"]), patch.object(
            registry, "REGISTRY_PATH", fixture["registry_path"]
        ), patch.object(registry, "QUEUE_PATH", fixture["queue_path"]), patch.object(
            registry, "grouped_clips", return_value=[fixture["clips"]]
        ), patch.object(registry, "validate_groups", return_value=[]), patch.object(
            registry, "run_batch", side_effect=run_batch
        ):
            self.assertTrue(registry.run_one_job())
        return (
            registry.load_json(fixture["registry_path"], {}),
            registry.load_json(fixture["queue_path"], {}),
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


if __name__ == "__main__":
    unittest.main()
