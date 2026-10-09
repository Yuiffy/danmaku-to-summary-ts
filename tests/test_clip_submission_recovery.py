import datetime as dt
import unittest
from unittest.mock import Mock

from src.scripts.clip_submission_recovery import (reconcile_intent, find_intent, intent_key, validate_queue_submission,
    SubmissionRecoveryPending, SubmissionRecoveryConflict)


class SubmissionRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.now = dt.datetime(2026, 10, 6, 12, tzinfo=dt.timezone.utc)
        self.clip = {"idx": 1, "path": "/clips/one.mp4"}
        self.intent = {"title": "Title", "mediaPath": self.clip["path"],
            "startedAt": (self.now - dt.timedelta(minutes=10)).isoformat()}
        self.state = {"submission_intents": {"1": self.intent.copy()}}
        self.rows = [{"title": "Other", "bvid": "BVother", "pubdate": int((self.now - dt.timedelta(hours=1)).timestamp())}]

    def test_complete_absence_consumes_only_bound_attempt_and_preserves_receipt(self):
        authorize = Mock(return_value=42)
        self.assertTrue(reconcile_intent(self.state, self.clip, "Title", "job", lambda: self.rows, authorize, self.now))
        self.assertEqual(authorize.call_count, 2)
        self.assertEqual(self.state["submission_intents"], {})
        receipt = self.state["reconciled_submission_intents"][0]
        self.assertEqual(receipt["clipId"], 42)
        self.assertEqual(receipt["intent"], self.intent)
        self.assertEqual(receipt["reconciliation"]["result"], "no_matching_archive")

    def test_uncertain_lookup_recent_attempt_and_existing_title_never_clear_intent(self):
        for rows, error in [([*self.rows, {"title": "Title", "bvid": "BVexists"}], SubmissionRecoveryConflict),
                ([{"title": "Other", "bvid": "BVother", "pubdate": int(self.now.timestamp())}], SubmissionRecoveryPending),
                ([{"title": "Other"}], SubmissionRecoveryPending)]:
            with self.subTest(rows=rows), self.assertRaises(error):
                reconcile_intent(self.state, self.clip, "Title", "job", lambda: rows, lambda *_: 42, self.now)
            self.assertIn("1", self.state["submission_intents"])
        self.state["submission_intents"]["1"]["startedAt"] = self.now.isoformat()
        lookup = Mock()
        with self.assertRaises(SubmissionRecoveryPending):
            reconcile_intent(self.state, self.clip, "Title", "job", lookup, lambda *_: 42, self.now)
        lookup.assert_not_called()

    def test_cancelled_job_and_changed_title_cannot_authorize_retry(self):
        for title, authorize in [("Changed", lambda *_: 42), ("Title", Mock(side_effect=SubmissionRecoveryConflict("cancelled")))]:
            with self.subTest(title=title), self.assertRaises(SubmissionRecoveryConflict):
                reconcile_intent(self.state, self.clip, title, "job", lambda: self.rows, authorize, self.now)
            self.assertIn("1", self.state["submission_intents"])
        authorize = Mock(side_effect=[42, SubmissionRecoveryConflict("cancelled during lookup")])
        with self.assertRaises(SubmissionRecoveryConflict):
            reconcile_intent(self.state, self.clip, "Title", "job", lambda: self.rows, authorize, self.now)
        self.assertIn("1", self.state["submission_intents"])

    def test_standalone_retry_does_not_gain_queue_authorization(self):
        with self.assertRaises(SubmissionRecoveryPending):
            reconcile_intent(self.state, self.clip, "Title", None, lambda: self.rows, now=self.now)

    def test_same_review_index_in_different_manifests_does_not_consume_another_intent(self):
        second = {"idx": 1, "path": "/clips/two.mp4"}
        self.assertEqual(find_intent(self.state, second), (None, None))
        self.state["submission_intents"][intent_key(second)] = {**self.intent, "mediaPath": second["path"]}
        reconcile_intent(self.state, second, "Title", "job", lambda: self.rows, lambda *_: 43, self.now)
        self.assertEqual(self.state["submission_intents"]["1"], self.intent)

    def test_running_manual_and_automatic_jobs_revalidate_review_and_authority(self):
        api = Mock()
        row = {"id": 42, "reviewIndex": 1, "mediaPath": self.clip["path"], "metadataPath": "/clips/one.json",
            "status": "uploading", "title": "Title", "prefix": "Prefix"}
        clip = {**self.clip, "metadataPath": row["metadataPath"], "title": "Title", "prefix": "Prefix"}
        api.load_json.side_effect = lambda *_: {"clips": {"42": row}}
        job = {"status": "running", "clipIds": [42]}
        api.find_queue_job.return_value = job
        api.validate_groups.return_value = []
        self.assertEqual(validate_queue_submission(clip, "job", api), 42)
        api.clip_auto_publication.validate_submission_authorization.assert_not_called()
        job["automaticPublication"] = True
        self.assertEqual(validate_queue_submission(clip, "job", api), 42)
        api.clip_auto_publication.validate_submission_authorization.assert_called_once_with(clip, "job", api)
        api.validate_groups.return_value = ["source changed"]
        with self.assertRaises(SubmissionRecoveryConflict):
            validate_queue_submission(clip, "job", api)
        api.validate_groups.return_value = []
        with self.assertRaises(SubmissionRecoveryConflict):
            validate_queue_submission({**clip, "title": "Changed"}, "job", api)
        job["status"] = "cancelled"
        with self.assertRaises(SubmissionRecoveryConflict):
            validate_queue_submission(clip, "job", api)

    def test_corrupted_bound_intent_cannot_be_treated_as_no_prior_attempt(self):
        for intent in (None, {**self.intent, "mediaPath": "/clips/foreign.mp4"}):
            self.state["submission_intents"][intent_key(self.clip)] = intent
            with self.subTest(intent=intent), self.assertRaises(SubmissionRecoveryConflict):
                find_intent(self.state, self.clip)


if __name__ == "__main__":
    unittest.main()
