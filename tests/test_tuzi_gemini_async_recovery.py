import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "src" / "scripts" / "tuzi_gemini_async.py"
spec = importlib.util.spec_from_file_location("tuzi_gemini_async_recovery_test", MODULE_PATH)
gemini_async = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gemini_async)


class FakeResponse:
    def __init__(self, status_code, body=None, content=b"", headers=None):
        self.status_code = status_code
        self._body = body or {}
        self.content = content
        self.headers = headers or {}
        self.text = json.dumps(self._body, ensure_ascii=False)
        self.elapsed = mock.Mock()
        self.elapsed.total_seconds.return_value = 0.1

    def json(self):
        return self._body


class TuziGeminiAsyncRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.reference = self.root / "reference.png"
        self.reference.write_bytes(b"reference")
        self.state_path = self.root / "comic_COMIC_FACTORY_REQUEST.json"

    def tearDown(self):
        self.tmp.cleanup()

    @mock.patch.object(gemini_async.requests, "get")
    @mock.patch.object(gemini_async.requests, "post")
    def test_persists_remote_task_id_before_polling_and_downloads_result(self, post, get):
        post.return_value = FakeResponse(
            200,
            {"id": "remote-task-1", "status": "queued"},
            headers={"x-request-id": "request-1"},
        )
        get.side_effect = [
            FakeResponse(200, {"id": "remote-task-1", "status": "completed", "video_url": "https://image.example/result.png"}),
            FakeResponse(200, content=b"png-result"),
        ]

        result = gemini_async.call_tuzi_gemini_async(
            prompt="prompt",
            reference_image_paths=[str(self.reference)],
            api_key="test-key",
            base_url="https://api.example",
            state_path=str(self.state_path),
            max_poll_time=1,
        )

        state = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.assertEqual(state["taskId"], "remote-task-1")
        self.assertEqual(state["requestId"], "request-1")
        self.assertEqual(state["status"], "downloaded")
        self.assertTrue(Path(result).exists())
        self.assertEqual(Path(result).read_bytes(), b"png-result")

    @mock.patch.object(gemini_async.requests, "get")
    @mock.patch.object(gemini_async.requests, "post")
    def test_resumes_persisted_task_without_submitting_again(self, post, get):
        self.state_path.write_text(json.dumps({
            "schemaVersion": 1,
            "provider": "tuZi",
            "model": "gemini-3-pro-image-preview-async",
            "baseUrl": "https://api.example",
            "status": "processing",
            "taskId": "remote-task-2",
        }), encoding="utf-8")
        get.side_effect = [
            FakeResponse(200, {"id": "remote-task-2", "status": "completed", "video_url": "https://image.example/result.png"}),
            FakeResponse(200, content=b"resumed-result"),
        ]

        result = gemini_async.call_tuzi_gemini_async(
            prompt="prompt",
            reference_image_paths=[str(self.reference)],
            api_key="test-key",
            base_url="https://api.example",
            state_path=str(self.state_path),
            max_poll_time=1,
        )

        post.assert_not_called()
        self.assertEqual(Path(result).read_bytes(), b"resumed-result")
        state = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.assertEqual(state["status"], "downloaded")
        self.assertEqual(state["taskId"], "remote-task-2")


if __name__ == "__main__":
    unittest.main()
