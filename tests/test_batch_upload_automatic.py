import asyncio
import io
import json
import tempfile
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from src.scripts import batch_upload as upload
from src.scripts.clip_upload_errors import has_terminal_upload_error


class AutomaticUploadRecoveryTests(unittest.TestCase):
    def test_incomplete_archive_lookup_is_unknown_not_empty_or_partial_success(self):
        first = Mock()
        first.json.return_value = {"code": 0, "data": {"arc_audits": [
            {"Archive": {"title": "Title", "bvid": "BV1"}}]}}
        failed = Mock()
        failed.json.return_value = {"code": -509, "message": "busy"}
        for responses in ([failed], [first, failed], [RuntimeError("network failure")]):
            with self.subTest(responses=responses), patch.object(upload.requests, "get", side_effect=responses):
                with self.assertRaises(upload.ArchiveLookupUnavailable):
                    upload.fetch_member_archives("test-cookie", pages=2)

    def test_empty_complete_archive_lookup_is_valid(self):
        response = Mock()
        response.json.return_value = {"code": 0, "data": {"arc_audits": []}}
        with patch.object(upload.requests, "get", return_value=response):
            self.assertEqual(upload.fetch_member_archives("test-cookie"), {})

    def test_pre_submit_lookup_failure_never_calls_uploader(self):
        uploader = AsyncMock()
        with patch.object(upload, "fetch_member_archives", side_effect=upload.ArchiveLookupUnavailable("unknown")), \
                patch.object(upload, "upload_one", uploader):
            with self.assertRaises(upload.ArchiveLookupUnavailable):
                asyncio.run(upload.upload_one_guarded({"idx": 1, "title": "Title"}, object(), "", [], 21, "", "", 30, 2))
        uploader.assert_not_called()

    def test_unknown_submission_is_persisted_and_restart_does_not_repeat_it(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            state_path = root / "state.json"
            secrets = root / "secrets.json"
            secrets.write_text("{}", encoding="utf-8")
            clip = {"idx": 1, "title": "Title", "path": str(root / "clip.mp4"),
                    "automaticPublicationRequired": True, "roomId": "25788785"}
            stack.enter_context(patch.object(upload.sys, "argv", ["batch_upload.py", "--manifest", str(root / "manifest.json"),
                "--state", str(state_path), "--collection-section-id", "123", "--delay", "0"]))
            stack.enter_context(patch.object(upload, "parse_upload_manifest", return_value=[clip]))
            stack.enter_context(patch.object(upload, "find_secrets_path", return_value=secrets))
            stack.enter_context(patch.object(upload, "fetch_member_archives", return_value={}))
            stack.enter_context(patch.object(upload, "search_existing_titles", return_value={}))
            stack.enter_context(patch.object(upload, "build_credential", return_value=object()))
            stack.enter_context(patch.object(upload, "wait_for_upload_available", AsyncMock(return_value=(True, "ok"))))
            stack.enter_context(patch.object(upload, "save_upload_state",
                side_effect=lambda path, state: Path(path).write_text(json.dumps(state), encoding="utf-8")))
            async def submit(*args, before_submit=None, **kwargs):
                before_submit()
                return {"idx": 1, "title": "Title", "status": "error", "error": "response lost"}

            uploader = stack.enter_context(patch.object(upload, "upload_one", AsyncMock(side_effect=submit)))
            with redirect_stdout(io.StringIO()) as output:
                self.assertEqual(asyncio.run(upload.main()), 2)
                self.assertEqual(asyncio.run(upload.main()), 2)
            self.assertEqual(uploader.await_count, 1)
            saved = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(upload.find_intent(saved, clip)[1]["mediaPath"], clip["path"])
            self.assertNotIn("1", saved.get("done", {}))
            self.assertFalse(has_terminal_upload_error(output.getvalue()))

            # A definitive rejection is safe to retry through the existing account cooldown.
            state_path.unlink()
            uploader.reset_mock()

            async def reject(*args, before_submit=None, **kwargs):
                before_submit()
                return {"idx": 1, "title": "Title", "status": "rate_limited", "errorCode": 137022}

            uploader.side_effect = reject
            with redirect_stdout(io.StringIO()) as output:
                self.assertEqual(asyncio.run(upload.main()), 75)
                self.assertEqual(asyncio.run(upload.main()), 75)
            self.assertEqual(uploader.await_count, 2)
            self.assertNotIn("1", json.loads(state_path.read_text(encoding="utf-8")).get("submission_intents", {}))
            self.assertNotIn("automatic submission outcome unknown", output.getvalue())

    def test_known_pre_submit_failure_does_not_persist_submission_intent(self):
        with tempfile.TemporaryDirectory() as directory, redirect_stdout(io.StringIO()):
            callback = Mock()
            clip = {"idx": 1, "title": "Title", "path": str(Path(directory) / "missing.mp4")}
            result = asyncio.run(upload.upload_one(clip, object(), "", [], 21, "", before_submit=callback))
        self.assertEqual(result["status"], "no_file")
        callback.assert_not_called()

    def test_automatic_406_attempt_does_not_retry_when_lookup_finds_nothing(self):
        for authority in ({"automaticPublicationRequired": True}, {"queueJobId": "manual-job"}):
            clip = {"idx": 1, "title": "Title", **authority}
            with self.subTest(authority=authority), patch.object(upload, "fetch_member_archives", return_value={}), \
                    patch.object(upload, "wait_for_upload_available", AsyncMock(return_value=(True, "ok"))), \
                    patch.object(upload, "upload_one", AsyncMock(return_value={"idx": 1, "title": "Title", "status": "got_406"})) as submit, \
                    patch.object(upload.asyncio, "sleep", AsyncMock()), redirect_stdout(io.StringIO()):
                result = asyncio.run(upload.upload_one_guarded(clip, object(), "", [], 21, "", "", 30, 3))
            self.assertEqual(result["status"], "got_406")
            self.assertEqual(submit.await_count, 1)


if __name__ == "__main__":
    unittest.main()
