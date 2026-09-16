import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


runner = load_module("seedance_queue_runner_under_test", SCRIPTS / "seedance_queue_runner.py")
admin = load_module("seedance_queue_admin_under_test", SCRIPTS / "seedance_queue_admin.py")
store_module = load_module("seedance_queue_store_under_test", SCRIPTS / "seedance_queue_store.py")


class SeedanceQueueRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.queue_path = self.root / "seedance_queue.json"
        self.image = self.root / "reference.png"
        self.image.write_bytes(b"reference")

    def tearDown(self):
        self.temp.cleanup()

    def write_queue(self, tasks, **extra):
        data = {"tasks": tasks, **extra}
        self.queue_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return data

    def task(self, task_id, model="seedance2.0", repeat=1, **extra):
        return {
            "id": task_id,
            "name": task_id,
            "prompt": "animation prompt",
            "reference_images": [str(self.image)],
            "ratio": "16:9",
            "model_version": model,
            "video_resolution": "720p",
            "repeat": repeat,
            "completed": 0,
            "status": "pending",
            "submit_ids": [],
            "inflight": [],
            **extra,
        }

    def test_vip_selection_precedes_normal_and_keeps_normal_slot(self):
        normal = self.task("normal-first")
        vip = self.task("vip-later", "seedance2.0_vip", repeat=2)
        data = self.write_queue([normal, vip])
        selected = runner.select_submission_tasks(data, runner.RunnerOptions(max_vip_inflight=2, max_normal_inflight=1, max_submissions_per_pass=3))
        self.assertEqual([task["id"] for task in selected], ["vip-later", "vip-later", "normal-first"])

    def test_vip_round_robin_does_not_starve_other_tasks(self):
        vip_a = self.task("vip-a", "seedance2.0_vip", repeat=3)
        vip_b = self.task("vip-b", "seedance2.0_vip", repeat=3)
        data = self.write_queue([vip_a, vip_b])
        selected = runner.select_submission_tasks(data, runner.RunnerOptions(max_vip_inflight=4, max_normal_inflight=0, max_submissions_per_pass=4))
        self.assertEqual([task["id"] for task in selected], ["vip-a", "vip-b", "vip-a", "vip-b"])

    def test_legacy_submitted_task_becomes_inflight(self):
        legacy = self.task("legacy", status="submitted", inflight=[], submit_ids=["remote-1"], submitted_at=100)
        self.assertTrue(runner.normalize_task(legacy))
        self.assertEqual(legacy["inflight"][0]["submit_id"], "remote-1")
        self.assertEqual(legacy["status"], "submitted")

    def test_normalize_persists_status_when_repeat_is_already_complete(self):
        finished = self.task("finished", repeat=2, completed=2)
        self.assertTrue(runner.normalize_task(finished))
        self.assertEqual(finished["remaining"], 0)
        self.assertEqual(finished["status"], "completed")

    def test_submit_uses_task_level_vip_profile(self):
        task = self.task("vip", "seedance2.0_vip")
        task["video_resolution"] = "1080p"
        calls = []

        class Result:
            returncode = 0
            stdout = '{"submit_id":"remote-1","gen_status":"querying"}'
            stderr = ""

        with patch.object(runner, "run", side_effect=lambda cmd, timeout: calls.append((cmd, timeout)) or Result()):
            self.assertEqual(runner.submit(task), "remote-1")
        cmd = calls[0][0]
        self.assertEqual(cmd[cmd.index("--model_version") + 1], "seedance2.0_vip")
        self.assertEqual(cmd[cmd.index("--video_resolution") + 1], "1080p")

    def test_submit_passes_seedance_25_duration_and_audio_reference(self):
        audio = self.root / "voice.mp3"
        audio.write_bytes(b"voice")
        task = self.task(
            "seedance-25",
            "seedance2.5",
            duration=30,
            video_resolution="1080p",
            audio_references=[str(audio)],
        )
        calls = []

        class Result:
            returncode = 0
            stdout = '{"submit_id":"remote-25","gen_status":"querying"}'
            stderr = ""

        with patch.object(runner, "run", side_effect=lambda cmd, timeout: calls.append((cmd, timeout)) or Result()):
            self.assertEqual(runner.submit(task), "remote-25")
        cmd = calls[0][0]
        self.assertEqual(cmd[cmd.index("--model_version") + 1], "seedance2.5")
        self.assertEqual(cmd[cmd.index("--duration") + 1], "30")
        self.assertEqual(cmd[cmd.index("--video_resolution") + 1], "1080p")
        self.assertEqual(cmd[cmd.index("--audio") + 1], str(audio))

    def test_validate_profile_accepts_seedance_25_resolution_and_duration_range(self):
        task = self.task("seedance-25", "seedance2.5", duration=30, video_resolution="1080p")
        self.assertIsNone(runner.validate_profile(task))
        task["video_resolution"] = "480p"
        self.assertIsNone(runner.validate_profile(task))

    def test_validate_profile_rejects_seedance_25_duration_above_cli_limit(self):
        task = self.task("seedance-25", "seedance2.5", duration=31)
        self.assertEqual(
            runner.validate_profile(task),
            "duration must be between 4 and 30 seconds: 31",
        )

    def test_dry_run_does_not_change_queue_bytes(self):
        data = self.write_queue([self.task("normal"), self.task("vip", "seedance2.0_vip")])
        before = self.queue_path.read_bytes()
        result = runner.run_once(store_module.QueueStore(self.queue_path), runner.RunnerOptions(dry_run=True))
        self.assertEqual(result.submitted, 0)
        self.assertEqual(self.queue_path.read_bytes(), before)
        self.assertEqual(data["tasks"][0]["status"], "pending")

    def test_concurrency_rejection_keeps_attempt_unconsumed_and_sets_cooldown(self):
        task = self.task("vip", "seedance2.0_vip", repeat=2)
        self.write_queue([task])
        store = store_module.QueueStore(self.queue_path)
        snapshot, token, error = runner.reserve_submission(store, "vip")
        self.assertIsNone(error)
        assert token
        runner.apply_submission_rejection(store, "vip", token, "ExceedConcurrencyLimit")
        saved = store.load()
        saved_task = saved["tasks"][0]
        self.assertEqual(saved_task["completed"], 0)
        self.assertEqual(saved_task["status"], "pending")
        self.assertGreater(saved["_seedance_runner"]["submission_cooldown_until"]["vip"], 0)

    def test_success_is_not_counted_when_download_fails(self):
        task = self.task("vip", "seedance2.0_vip", status="submitted", inflight=[{"submit_id": "remote-1", "next_query_at": 0}])
        self.write_queue([task])
        store = store_module.QueueStore(self.queue_path)
        with patch.object(runner, "download", side_effect=RuntimeError("disk full")):
            with self.assertRaisesRegex(RuntimeError, "disk full"):
                runner.apply_query_result(store, "vip", "remote-1", {"gen_status": "success"})
        saved = store.load()["tasks"][0]
        self.assertEqual(saved["completed"], 0)
        self.assertEqual(len(saved["inflight"]), 1)

    def test_empty_queue_notifier_waits_for_pending_tasks(self):
        self.write_queue(
            [self.task("pending")],
            _meta={"dreamina_session_id": "session-1", "dreamina_session_name": "validation"},
        )
        store = store_module.QueueStore(self.queue_path)
        with patch.object(runner, "load_wechat_webhook_url", return_value="https://example.invalid"), patch.object(runner, "send_wechat_markdown") as send:
            self.assertFalse(runner.maybe_notify_empty_queue(store))
        send.assert_not_called()

    def test_empty_queue_notifier_sends_once_and_rearms_for_new_tasks(self):
        submitted = self.task(
            "submitted",
            status="submitted",
            repeat=2,
            inflight=[{"submit_id": "remote-1"}],
        )
        self.write_queue(
            [submitted],
            _meta={"dreamina_session_id": "session-1", "dreamina_session_name": "validation"},
        )
        store = store_module.QueueStore(self.queue_path)
        with patch.object(runner, "load_wechat_webhook_url", return_value="https://example.invalid"), patch.object(runner, "send_wechat_markdown") as send:
            self.assertTrue(runner.maybe_notify_empty_queue(store))
            self.assertFalse(runner.maybe_notify_empty_queue(store))
            self.assertEqual(send.call_count, 1)
            self.assertIn("validation", send.call_args.args[1])

            with store.transaction() as data:
                data["tasks"].append(self.task("new-pending"))
                store.save(data)
            self.assertFalse(runner.maybe_notify_empty_queue(store))
            self.assertFalse(store.load()["_meta"][runner.EMPTY_QUEUE_NOTIFIED_KEY])

            with store.transaction() as data:
                new_task = runner.task_by_id(data, "new-pending")
                assert new_task is not None
                new_task["status"] = "submitted"
                new_task["inflight"] = [{"submit_id": "remote-2"}]
                store.save(data)
            self.assertTrue(runner.maybe_notify_empty_queue(store))
            self.assertEqual(send.call_count, 2)

    def test_reset_clears_inflight_and_reservations(self):
        task = self.task("vip", "seedance2.0_vip", status="paused", completed=1, inflight=[{"submit_id": "remote-1"}], submission_reservations=[{"token": "token"}], fail_count=3)
        self.write_queue([task])
        args = type("Args", (), {"queue": self.queue_path, "task_ids": ["vip"], "default_repeat": 3, "note": "reset", "dry_run": False})()
        self.assertEqual(admin.reset_tasks(args), 0)
        saved = store_module.QueueStore(self.queue_path).load()["tasks"][0]
        self.assertEqual(saved["status"], "pending")
        self.assertEqual(saved["completed"], 0)
        self.assertEqual(saved["inflight"], [])
        self.assertNotIn("submission_reservations", saved)

    def test_store_atomic_transaction_writes_valid_json(self):
        self.write_queue([])
        store = store_module.QueueStore(self.queue_path)
        with store.transaction() as data:
            data["tasks"].append(self.task("one"))
            store.save(data)
        self.assertEqual(store.load()["tasks"][0]["id"], "one")
        self.assertFalse(store.lock_path.exists())


if __name__ == "__main__":
    unittest.main()
