"""Frequency, concurrency and pickup contracts without providers or live queues."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from seedance_qq_limits import DEFAULT_LIMITS, admission, policy
from seedance_queue_store import QueueStore
import seedance_qq_bridge as bridge

NOW = 1794809442
OWNER = dict(app="900000001", user="a" * 64, conversation="b" * 64, request="c" * 64)
OPERATOR = dict(dailyLimit=300, userDailyLimit=150, userWindowLimit=50,
                intervalSeconds=10, maxActive=4, independentInterval=True)


def task(index, at, user=OWNER["user"], status="completed"):
    return dict(id=str(index), qq={**OWNER, "user": user}, status=status, qq_admitted_at=at)


class QQVideoLimitTests(unittest.TestCase):
    def test_regular_video_matches_image_window_day_and_global_interval(self):
        self.assertEqual(admission([task(1, NOW - 2, "d" * 64)], OWNER, DEFAULT_LIMITS, NOW),
                         dict(status="limited", limitReason="interval", retryAt=(NOW + 58) * 1000))
        for count, age, expected in ((10, 60, "user_window"), (30, 18001, "user_daily")):
            result = admission([task(i, NOW - age) for i in range(count)], OWNER, DEFAULT_LIMITS, NOW)
            self.assertEqual(result["limitReason"], expected)
        tasks = [task(i, NOW - 61, "d" * 64) for i in range(300)]
        self.assertEqual(admission(tasks, OWNER, DEFAULT_LIMITS, NOW)["limitReason"], "global_daily")

    def test_operator_has_independent_interval_but_window_day_and_concurrency_remain_bounded(self):
        self.assertIsNone(admission([task(1, NOW - 1, "d" * 64)], OWNER, OPERATOR, NOW))
        self.assertEqual(admission([task(1, NOW - 1)], OWNER, OPERATOR, NOW)["limitReason"], "user_interval")
        self.assertIsNone(admission([task(i, NOW - 61) for i in range(49)], OWNER, OPERATOR, NOW))
        self.assertEqual(admission([task(i, NOW - 61) for i in range(50)], OWNER, OPERATOR, NOW)["limitReason"], "user_window")
        self.assertEqual(admission([task(i, NOW - 18001) for i in range(150)], OWNER, OPERATOR, NOW)["limitReason"], "user_daily")
        active = [task(i, NOW - 61, status="submitted") for i in range(4)]
        self.assertEqual(admission(active, OWNER, OPERATOR, NOW), dict(status="busy"))

    def test_draft_and_legacy_history_and_overlapping_reset_times(self):
        self.assertIsNone(admission([dict(id="draft", qq=OWNER, status="draft", created_at=NOW)], OWNER, DEFAULT_LIMITS, NOW))
        legacy = dict(id="legacy", qq=OWNER, status="completed", created_at=NOW - 1)
        self.assertEqual(admission([legacy], OWNER, DEFAULT_LIMITS, NOW)["limitReason"], "interval")
        midnight = ((NOW + 28800) // 86400 + 1) * 86400 - 28800
        events = [task(i, midnight - 60) for i in range(10)]
        self.assertEqual(admission(events, OWNER, DEFAULT_LIMITS, midnight + 1)["retryAt"], (midnight - 60 + 18000) * 1000)
        self.assertIsNone(admission(events, OWNER, DEFAULT_LIMITS, midnight - 60 + 18000))
        for invalid in ({}, {**OPERATOR, "maxActive": 5}, {**OPERATOR, "intervalSeconds": 0}, {**OPERATOR, "independentInterval": 1}):
            with self.assertRaises(ValueError):
                policy(dict(admission=invalid))

    def test_bridge_checks_direct_and_draft_approval_under_lock_without_charging_previews(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(bridge.time, "time", return_value=NOW):
            queue = Path(directory) / "queue.json"
            queue.write_text('{"tasks":[]}', encoding="utf-8")
            payload = dict(action="enqueue", owner=OWNER, prompt="rain", images=[], audio=[],
                           model="seedance2.0fast_vip", ratio="9:16", duration=15, resolution="720p", direct=False,
                           draft=dict(prompt="rain", materials=[], sourceCount=0), admission=OPERATOR)
            first = bridge.handle(queue, payload)
            self.assertEqual(first["status"], "draft")
            self.assertNotIn("qq_admitted_at", QueueStore(queue).load()["tasks"][0])
            self.assertEqual(bridge.handle(queue, dict(action="approve", owner=OWNER, admission=OPERATOR))["status"], "pending")
            for index in range(1, 4):
                with patch.object(bridge.time, "time", return_value=NOW + index * 10):
                    payload["owner"] = {**OWNER, "request": str(index) * 64}
                    self.assertEqual(bridge.handle(queue, {**payload, "direct": True})["status"], "pending")
            payload["owner"] = {**OWNER, "request": "f" * 64, "conversation": "e" * 64}
            self.assertEqual(bridge.handle(queue, {**payload, "direct": True})["status"], "busy")
            self.assertEqual(bridge.handle(queue, {**payload, "direct": False})["status"], "draft")
            self.assertEqual(bridge.handle(queue, dict(action="approve", owner=payload["owner"], admission=OPERATOR))["status"], "busy")
            # Replaying an admitted request succeeds even while all four slots are full.
            self.assertEqual(bridge.handle(queue, {**payload, "owner": OWNER, "direct": True})["status"], "pending")
            self.assertEqual(sum("qq_admitted_at" in item for item in QueueStore(queue).load()["tasks"]), 4)

    def test_pickup_returns_latest_result_and_delivery_acknowledges_only_that_task(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory) / "queue.json"
            tasks = [task(i, NOW - 61) for i in range(2)]
            queue.write_text(json.dumps(dict(tasks=tasks)), encoding="utf-8")
            self.assertEqual(bridge.handle(queue, dict(action="status", owner=OWNER))["taskId"], "1")
            other = {**OWNER, "user": "d" * 64}
            self.assertEqual(bridge.handle(queue, dict(action="delivered", owner=other, taskId="1"))["status"], "missing")
            bridge.handle(queue, dict(action="delivered", owner=OWNER, taskId="1"))
            first_receipt = QueueStore(queue).load()["tasks"][1]["qq_delivered_at"]
            bridge.handle(queue, dict(action="delivered", owner=OWNER, taskId="1"))
            saved = QueueStore(queue).load()["tasks"]
            self.assertNotIn("qq_delivered_at", saved[0])
            self.assertEqual(saved[1]["qq_delivered_at"], first_receipt)
            self.assertEqual(bridge.handle(queue, dict(action="status", owner=OWNER))["taskId"], "1")

    def test_latest_task_progress_or_failure_never_falls_back_to_an_old_video(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory) / "queue.json"
            for status in ("pending", "submitted", "draft", "paused", "needs_review", "failed", "cancelled"):
                with self.subTest(status=status):
                    tasks = [task(0, NOW - 86400), task(1, NOW, status=status)]
                    tasks[0]["qq_output"] = "yesterday.mp4"
                    queue.write_text(json.dumps(dict(tasks=tasks)), encoding="utf-8")
                    result = bridge.handle(queue, dict(action="status", owner=OWNER))
                    self.assertEqual(result["taskId"], "1")
                    self.assertEqual(result["status"], status)
                    self.assertIsNone(result["file"])

    def test_latest_legacy_task_is_not_hidden_by_older_admitted_or_foreign_tasks(self):
        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory) / "queue.json"
            tasks = [task(0, NOW - 86400), task(1, NOW)]
            tasks[1].pop("qq_admitted_at")
            tasks[1]["created_at"] = NOW
            tasks[1]["qq_output"] = "today.mp4"
            for field, value in (("user", "d" * 64), ("conversation", "e" * 64), ("app", "900000002")):
                foreign = task(len(tasks), NOW + 1)
                foreign["qq"] = {**OWNER, field: value}
                tasks.append(foreign)
            queue.write_text(json.dumps(dict(tasks=tasks)), encoding="utf-8")
            result = bridge.handle(queue, dict(action="status", owner=OWNER))
            self.assertEqual(result["taskId"], "1")
            self.assertEqual(result["file"], "today.mp4")
            # Exact-request replay still resolves its original task, independently of pickup.
            tasks[1]["qq"]["request"] = "d" * 64
            queue.write_text(json.dumps(dict(tasks=tasks)), encoding="utf-8")
            self.assertEqual(bridge.handle(queue, dict(action="lookup", owner=OWNER))["taskId"], "0")


if __name__ == "__main__":
    unittest.main()
