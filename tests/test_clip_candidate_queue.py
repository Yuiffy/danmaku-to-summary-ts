import argparse
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from src.scripts import clip_candidate_queue


class ClipCandidateQueueTests(unittest.TestCase):
    def test_selected_precision_rebuild_restores_baseline_only_after_success(self):
        for ordinary, published, fails in ((False, False, False), (True, True, False),
                                            (True, False, True), (True, False, False)):
            with self.subTest(ordinary=ordinary, published=published, fails=fails):
                clip = {"id": 2, "metadataPath": "precision/publication.json", "status": "uploaded" if published else "review",
                        "precisionSelection": {"originalMetadataPath": "original.json"}}
                registry, queue = {"clips": {"2": clip}}, {"jobs": []}
                api = MagicMock()
                api.REGISTRY_PATH, api.QUEUE_PATH = "registry", "queue"
                api.subprocess.TimeoutExpired = TimeoutError
                api.load_json.side_effect = lambda path, _default: registry if path == "registry" else queue
                args = argparse.Namespace(id=2, enqueue=False, ordinary=ordinary, start=1, end=61,
                                          allow_long=False, review_note="Re-edit authorized source", feedback_authorized=True)
                result = {"candidateSrtPath": "draft.srt", "candidateSrtSha256": "hash", "candidateRevision": 0,
                          "copy": {"title": "Title", "description": "Description"}, "pendingRebuild": True}
                with patch.object(clip_candidate_queue, "candidate_action", return_value=result,
                                  side_effect=ValueError("Source changed") if fails else None) as action:
                    success = ordinary and not published and not fails
                    self.assertEqual(clip_candidate_queue.prepare_rebuild(args, api), 0 if success else 2)
                    if ordinary and not published:
                        self.assertEqual(action.call_args.args[1]["metadataPath"], "original.json")
                    else:
                        action.assert_not_called()
                if success:
                    self.assertEqual(clip["metadataPath"], "original.json")
                    self.assertNotIn("precisionSelection", clip)
                    self.assertTrue(clip["pendingRebuild"])
                    api.save_json.assert_called_once()
                else:
                    self.assertEqual(clip["metadataPath"], "precision/publication.json")
                    self.assertIn("precisionSelection", clip)
                    api.save_json.assert_not_called()

    def test_duplicate_source_is_rejected_before_render(self):
        self.check_duplicate_render(False)

    def test_local_precision_baseline_can_render_before_final_retained_span_check(self):
        self.check_duplicate_render(True)

    def test_precision_baseline_cannot_be_used_by_unapproved_or_upload_worker_actions(self):
        for feedback, worker in ((False, False), (True, True)):
            args = argparse.Namespace(precision_baseline=True, feedback_authorized=feedback, require_approval=worker)
            self.assertEqual(clip_candidate_queue.cut_candidates(args, None), 2)

    def check_duplicate_render(self, precision_baseline):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            metadata = root / "candidate.json"
            metadata.write_text("{}", encoding="utf-8")
            registry_path = root / "registry.json"
            queue_path = root / "queue.json"
            registry = {"clips": {"2": {
                "id": 2, "metadataPath": str(metadata), "pendingRebuild": True,
                "reviewPath": str(root / 'REVIEW.md'), "statePath": str(root / 'state.json'),
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

                @staticmethod
                def import_json(_args):
                    return 0

            args = argparse.Namespace(ids="2", review_note="投", title=None,
                                      description=None, cover_text=None, tags=None,
                                      automatic_review=False, feedback_authorized=True,
                                      require_approval=False, timeout_seconds=60, precision_baseline=precision_baseline)
            with patch.object(clip_candidate_queue, "duplicate_errors", return_value=[
                "duplicate source content: clip 2 overlaps clip 1 (BVOLD)"
            ]), patch.object(clip_candidate_queue, "candidate_action") as render:
                self.assertEqual(clip_candidate_queue.cut_candidates(args, Api()), 0 if precision_baseline else 2)
            if precision_baseline:
                render.assert_called_once()
                return
            render.assert_not_called()
            saved = json.loads(registry_path.read_text(encoding="utf-8"))
            self.assertIn("duplicate source content", saved["clips"]["2"]["candidateError"])


if __name__ == "__main__":
    unittest.main()
