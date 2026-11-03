import argparse
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from src.scripts import clip_candidate_queue


class ClipCandidateQueueTests(unittest.TestCase):
    def test_duplicate_source_is_rejected_before_render(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            metadata = root / "candidate.json"
            metadata.write_text("{}", encoding="utf-8")
            registry_path = root / "registry.json"
            queue_path = root / "queue.json"
            registry = {"clips": {"2": {
                "id": 2, "metadataPath": str(metadata), "pendingRebuild": True,
                "reviewPending": True, "status": "pending_rebuild", "mediaPath": "candidate.mp4",
            }, "1": {"id": 1, "status": "uploaded", "mediaPath": "old.mp4"}}}
            registry_path.write_text(json.dumps(registry), encoding="utf-8")
            queue_path.write_text(json.dumps({"jobs": []}), encoding="utf-8")

            class Api:
                REGISTRY_PATH = registry_path
                QUEUE_PATH = queue_path
                PROJECT_ROOT = root
                subprocess = SimpleNamespace(TimeoutExpired=TimeoutError)

                @staticmethod
                def parse_int_list(value):
                    return [int(value)]

                @staticmethod
                def default_registry():
                    return {"clips": {}}

                @staticmethod
                def default_queue():
                    return {"jobs": []}

                @staticmethod
                def load_json(path, default):
                    try:
                        return json.loads(Path(path).read_text(encoding="utf-8"))
                    except (FileNotFoundError, json.JSONDecodeError):
                        return default

                @staticmethod
                def save_json(path, value):
                    Path(path).write_text(json.dumps(value), encoding="utf-8")

                @staticmethod
                def acquire_queue_mutation_lock():
                    return None

                @staticmethod
                def release_queue_mutation_lock(_handle):
                    return None

            args = argparse.Namespace(ids="2", review_note="投", title=None,
                                      description=None, cover_text=None, tags=None,
                                      automatic_review=False, feedback_authorized=True,
                                      require_approval=False, timeout_seconds=60)
            with patch.object(clip_candidate_queue, "duplicate_errors", return_value=[
                "duplicate source content: clip 2 overlaps clip 1 (BVOLD)"
            ]), patch.object(clip_candidate_queue, "candidate_action") as render:
                self.assertEqual(clip_candidate_queue.cut_candidates(args, Api()), 2)
            render.assert_not_called()
            saved = json.loads(registry_path.read_text(encoding="utf-8"))
            self.assertIn("duplicate source content", saved["clips"]["2"]["candidateError"])


if __name__ == "__main__":
    unittest.main()
