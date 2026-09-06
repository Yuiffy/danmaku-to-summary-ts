import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "scripts"))

from comic.image_routes import ImageRouteIO, generate_image


class ImageRoutesTest(unittest.TestCase):
    def setUp(self):
        self.metadata = {}
        self.io = ImageRouteIO(
            compatible=Mock(return_value=None),
            images=Mock(return_value="result.png"),
            reset_metadata=self.metadata.clear,
            read_metadata=lambda: dict(self.metadata),
            annotate_metadata=lambda **values: self.metadata.update(values),
            log=Mock(),
        )
        self.routes = [
            {"provider": "primary", "flow": "tuZiCompatible", "maxAttempts": 2, "timeoutMs": 1234},
            {"provider": "fallback", "flow": "openaiImages"},
        ]
        self.config = {
            "aiServices": {},
            "ai": {
                "providers": {
                    name: {"options": {"baseUrl": "https://example.invalid", "apiKey": "test"}}
                    for name in ("primary", "fallback")
                },
                "roomSettings": {"123": {"imageGeneration": {"routes": self.routes}}},
            },
        }

    def test_retries_then_falls_back_preserving_recovery_and_provenance(self):
        def failed(**kwargs):
            self.metadata.update(status="failure", reason="temporary failure")
        self.io.compatible.side_effect = failed
        references = ["host.png", "evidence.jpg"]
        result = generate_image("prompt", references, "123", "recovery.json", config=self.config, io=self.io)
        self.assertEqual(result, "result.png")
        self.assertEqual(self.io.compatible.call_count, 2)
        self.io.images.assert_called_once()
        for attempt in self.io.compatible.call_args_list:
            self.assertEqual(attempt.kwargs["recovery_state_path"], "recovery.json")
            self.assertIs(attempt.kwargs["reference_image_path"], references)
            self.assertEqual(attempt.kwargs["timeout"], 1.234)
        self.assertIs(self.io.images.call_args.kwargs["reference_image_path"], references)
        self.assertEqual(self.metadata["provider"], "fallback")
        self.assertEqual([a["status"] for a in self.metadata["routeAttempts"]], ["failure", "failure", "success"])
        self.assertEqual(self.metadata["routeAttempts"][0]["reason"], "temporary failure")

    def test_total_failure_records_all_attempts_without_calling_unconfigured_provider(self):
        self.config["ai"]["providers"].pop("fallback")
        result = generate_image("prompt", room_id="123", config=self.config, io=self.io)
        self.assertIsNone(result)
        self.io.images.assert_not_called()
        self.assertEqual(self.metadata["status"], "failure")
        self.assertEqual(len(self.metadata["routeAttempts"]), 3)
        self.assertEqual(self.metadata["endpoint"], "imageGenerationRoutes")

    def test_success_does_not_retry_and_retains_provider_metadata(self):
        def success(**kwargs):
            self.metadata.update(endpoint="async", taskId="provider-job", attempts=[{"status": "success"}])
            return "result.png"
        self.io.compatible.side_effect = success
        self.assertEqual(generate_image("prompt", room_id="123", config=self.config, io=self.io), "result.png")
        self.io.compatible.assert_called_once()
        self.io.images.assert_not_called()
        self.assertEqual(self.metadata["taskId"], "provider-job")
        self.assertEqual(self.metadata["endpoint"], "async")


if __name__ == "__main__":
    unittest.main()
