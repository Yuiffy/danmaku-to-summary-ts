import asyncio
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import ExitStack, redirect_stdout

from src.scripts import clip_upload_registry as registry
from src.scripts import batch_upload
from src.scripts.clip_upload_errors import has_terminal_upload_error, terminal_upload_error_reason
from src.scripts.clip_upload_input import load_queued_upload_clips


class QueuedUploadInputTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name, value in (("RUNTIME_DIR", self.root), ("REGISTRY_PATH", self.root / "registry.json"),
                            ("QUEUE_PATH", self.root / "queue.json")):
            patched = patch.object(registry, name, value)
            patched.start()
            self.addCleanup(patched.stop)
        self.manifest = self.root / "UPLOAD_MANIFEST.json"
        self.metadata = self.root / "original.json"
        self.metadata.write_text(json.dumps({"copy": {"title": "原场次切片"},
            "output": {"mediaPath": str(self.root / "original.mp4")}}), encoding="utf-8")
        # A later stream reuses index 1 and drops the old high candidate index.
        self.manifest.write_text(json.dumps({"clips": [{"reviewIndex": 1, "metadata": {
            "mode": "own_stream_fun_review", "uploadReady": True,
            "automaticPublicationRequired": True, "publicationReview": {"status": "needs_review"},
            "copy": {"title": "另一场直播"}}}]}), encoding="utf-8")
        clip = {"id": 4002, "status": "uploading", "reviewIndex": 1,
                "manifestPath": str(self.manifest), "metadataPath": str(self.metadata),
                "mediaPath": str(self.root / "original.mp4"), "coverPath": str(self.root / "cover.jpg"),
                "statePath": str(self.root / "upload_state.json"), "source": "原场次", "title": "原场次切片",
                "prefix": "【小岁】", "tags": ["小岁"], "tid": 21}
        second = self.root / "second.json"
        second.write_text(json.dumps({"copy": {"title": "原场次另一条切片"},
            "output": {"mediaPath": str(self.root / "second.mp4")}}), encoding="utf-8")
        self.records = {"clips": {"4002": clip, "4010": {**clip, "id": 4010, "reviewIndex": 4028232656,
            "title": "原场次另一条切片", "mediaPath": str(self.root / "second.mp4"), "metadataPath": str(second)}}}
        self.job = {"id": "upload-test", "status": "running", "clipIds": [4002, 4010]}
        self.save()

    def save(self):
        registry.REGISTRY_PATH.write_text(json.dumps(self.records), encoding="utf-8")
        registry.QUEUE_PATH.write_text(json.dumps({"jobs": [self.job]}), encoding="utf-8")

    def load(self, ids="4002,4010", job="upload-test"):
        return load_queued_upload_clips(ids, job, api=registry)

    def test_replaced_manifest_does_not_change_queued_media_or_drop_ids(self):
        with self.assertRaisesRegex(ValueError, "final publication review"):
            registry.load_upload_manifest(self.manifest, selected_indices={1})
        self.assertEqual(registry.load_upload_manifest(self.manifest, selected_indices={4028232656}), [])
        clips = self.load()
        self.assertEqual([clip["idx"] for clip in clips], [1, 4028232656])
        self.assertEqual(clips[0]["title"], "原场次切片")
        self.assertEqual(clips[0]["path"], str(self.root / "original.mp4"))
        self.assertEqual(clips[0]["cover"], str(self.root / "cover.jpg"))
        self.assertEqual(clips[0]["metadataPath"], str(self.metadata))

    def test_removed_manifest_is_not_required(self):
        self.manifest.unlink()
        self.assertEqual(len(self.load()), 2)

    def test_batch_cli_uses_stable_ids_without_parsing_replaced_manifest(self):
        secrets = self.root / "secrets.json"
        secrets.write_text('{"bilibili":{"cookie":"fixture"}}', encoding="utf-8")
        output = io.StringIO()
        with ExitStack() as stack:
            stack.enter_context(patch.object(sys, "argv", ["batch_upload.py", "--manifest", str(self.manifest),
                "--queue-job", "upload-test", "--queue-ids", "4002,4010", "--dry-run"]))
            stack.enter_context(patch.object(batch_upload, "load_queued_upload_clips", side_effect=self.load))
            parse = stack.enter_context(patch.object(batch_upload, "parse_upload_manifest"))
            stack.enter_context(patch.object(batch_upload, "find_secrets_path", return_value=str(secrets)))
            stack.enter_context(patch.object(batch_upload, "fetch_member_archives", return_value={}))
            stack.enter_context(patch.object(batch_upload, "search_existing_titles", return_value={}))
            stack.enter_context(patch.object(batch_upload, "save_upload_state"))
            stack.enter_context(redirect_stdout(output))
            self.assertEqual(asyncio.run(batch_upload.main()), 0)
            parse.assert_not_called()
        self.assertIn("原场次切片", output.getvalue())
        self.assertIn("4028232656", output.getvalue())
        self.assertNotIn("另一场直播", output.getvalue())

    def test_cli_distinguishes_review_failure_from_unreadable_input(self):
        output = io.StringIO()
        with patch.object(sys, "argv", ["batch_upload.py", "--manifest", str(self.manifest)]), redirect_stdout(output):
            self.assertEqual(asyncio.run(batch_upload.main()), 1)
        self.assertIn("上传资料校验失败: final publication review", output.getvalue())
        self.assertTrue(has_terminal_upload_error(output.getvalue()))
        self.assertIn("final publication review has not passed", terminal_upload_error_reason(output.getvalue()))
        output = io.StringIO()
        self.manifest.unlink()
        with patch.object(sys, "argv", ["batch_upload.py", "--manifest", str(self.manifest)]), redirect_stdout(output):
            self.assertEqual(asyncio.run(batch_upload.main()), 1)
        self.assertIn("无法读取上传资料", output.getvalue())
        self.assertTrue(has_terminal_upload_error(output.getvalue()))

    def test_only_explicit_ids_are_loaded_in_requested_order(self):
        self.assertEqual([c["id"] for c in self.load("4010,4002")], [4010, 4002])
        self.assertEqual([c["id"] for c in self.load("4010")], [4010])

    def test_unknown_job_or_nonrunning_job_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "not running"):
            self.load(job="other-job")
        self.job["status"] = "cancelled"
        self.save()
        with self.assertRaisesRegex(ValueError, "not running"):
            self.load()

    def test_ids_outside_job_or_missing_registry_are_rejected(self):
        self.job["clipIds"] = [4002]
        self.save()
        with self.assertRaisesRegex(ValueError, "4010 does not belong"):
            self.load()
        self.job["clipIds"].append(4010)
        del self.records["clips"]["4010"]
        self.save()
        with self.assertRaisesRegex(ValueError, "4010 does not belong"):
            self.load()

    def test_cancellation_and_uploaded_records_are_rejected(self):
        self.job["cancellationRequests"] = {"4002": {"reason": "停止"}}
        self.save()
        with self.assertRaisesRegex(ValueError, "cancelled"):
            self.load()
        del self.job["cancellationRequests"]
        self.records["clips"]["4002"]["uploadCancellation"] = {"jobId": "upload-test"}
        self.save()
        with self.assertRaisesRegex(ValueError, "cancelled"):
            self.load()
        del self.records["clips"]["4002"]["uploadCancellation"]
        self.records["clips"]["4002"]["status"] = "uploaded"
        self.save()
        with self.assertRaisesRegex(ValueError, "already uploaded"):
            self.load()

    def test_current_review_is_still_required(self):
        metadata = json.loads(self.metadata.read_text(encoding="utf-8"))
        metadata.update(mode="own_stream_fun_review", uploadReady=True,
                        automaticPublicationRequired=True, publicationReview={"status": "needs_review"})
        self.metadata.write_text(json.dumps(metadata), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "final publication review"):
            self.load()

    def test_mixed_sessions_and_ambiguous_indices_are_rejected(self):
        self.records["clips"]["4010"]["source"] = "另一场直播"
        self.save()
        with self.assertRaisesRegex(ValueError, "one upload group"):
            self.load()
        self.records["clips"]["4010"]["source"] = "原场次"
        self.records["clips"]["4010"]["reviewIndex"] = 1
        self.save()
        with self.assertRaisesRegex(ValueError, "ambiguous review indices"):
            self.load()

    def test_invalid_id_lists_are_rejected(self):
        for ids in ("", "0", "-1", "4002,4002", "unknown"):
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                self.load(ids)
        with self.assertRaisesRegex(ValueError, "requires a job"):
            self.load(job=None)


if __name__ == "__main__":
    unittest.main()
