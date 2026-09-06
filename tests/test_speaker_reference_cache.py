import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PYTHON_DIR = Path(__file__).resolve().parents[1] / "src/scripts/python"
sys.path.insert(0, str(PYTHON_DIR))

import sensevoice_speaker


class SpeakerReferenceCacheTests(unittest.TestCase):
    def setUp(self):
        import torch

        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "reference.wav"
        self.path.write_bytes(b"original")
        self.references = [{"speaker": "Host", "state": "chat", "audio_path": str(self.path), "chunk_s": 1}]
        self.cache = {}
        self.payload = {}
        self.model = object()
        audio_patch = patch.object(sensevoice_speaker, "load_audio_16k_mono", return_value=([0.0] * 32000, 16000))
        self.audio = audio_patch.start()
        self.addCleanup(audio_patch.stop)
        generate_patch = patch.object(sensevoice_speaker, "_generate_speaker_embeddings", return_value=[
            torch.tensor([[1.0, 0.0]]), torch.tensor([[0.99, 0.01]]),
        ])
        self.generate = generate_patch.start()
        self.addCleanup(generate_patch.stop)

    def load(self, **overrides):
        return sensevoice_speaker.build_speaker_reference_centroids(
            overrides.pop("model", self.model), overrides.pop("references", self.references),
            overrides.pop("device", "cpu"), runtime_cache=self.cache, payload=self.payload, **overrides,
        )

    def test_reuses_prototypes_and_reports_cache_hit(self):
        first = self.load()
        second = self.load()
        self.assertIs(first, second)
        self.assertEqual(self.generate.call_count, 1)
        self.assertEqual(self.audio.call_count, 1)
        self.assertEqual(self.payload["_timings"]["reference_cache_hit"], 1)

    def test_detects_same_size_replacement_with_preserved_mtime(self):
        self.load()
        stamp = self.path.stat()
        self.path.write_bytes(b"replaced")
        os.utime(self.path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        self.load()
        self.assertEqual(self.generate.call_count, 2)
        self.assertEqual(self.payload["_timings"]["reference_cache_hit"], 0)

    def test_model_device_reference_and_prototype_options_invalidate(self):
        changes = [{"model": object()}, {"device": "cuda"}, {"batch_size": 2},
                   {"prototype_merge_threshold": 0.8}, {"max_prototypes": 2}, {"prototype_min_support_chunks": 1}]
        for field, value in (("speaker", "Other"), ("state", "singing"), ("start_s", 0.25),
                             ("end_s", 1.5), ("chunk_s", 2), ("max_chunks", 1)):
            references = copy.deepcopy(self.references)
            references[0][field] = value
            changes.append({"references": references})
        for change in changes:
            with self.subTest(change=change):
                self.cache.clear()
                self.load()
                count = self.generate.call_count
                self.load(**change)
                self.assertEqual(self.generate.call_count, count + 1)

    def test_deleted_reference_drops_old_identity_and_recreation_rebuilds(self):
        self.load()
        self.path.unlink()
        self.generate.return_value = []
        self.assertIsNone(self.load())
        self.assertNotIn("speaker_reference_centroids", self.cache)
        self.path.write_bytes(b"replaced")
        self.load()
        self.assertEqual(self.audio.call_count, 2)

    def test_failure_or_partial_embeddings_are_not_cached(self):
        self.load()
        self.path.write_bytes(b"new-data")
        self.generate.side_effect = RuntimeError("embedding failed")
        with self.assertRaisesRegex(RuntimeError, "embedding failed"):
            self.load()
        self.assertNotIn("speaker_reference_centroids", self.cache)
        self.generate.side_effect = None
        self.generate.return_value[1] = None
        self.load()
        self.assertNotIn("speaker_reference_centroids", self.cache)

    def test_reference_changed_during_extraction_is_not_cached(self):
        embeddings = self.generate.return_value

        def replace_file(*args, **kwargs):
            self.path.write_bytes(b"new-data")
            return embeddings

        self.generate.side_effect = replace_file
        self.load()
        self.assertNotIn("speaker_reference_centroids", self.cache)

    def test_matching_threshold_changes_reuse_the_same_reference_prototypes(self):
        self.load()
        self.payload["speaker_reference_threshold"] = 0.75
        self.payload["speaker_reference_margin"] = 0.2
        self.load()
        self.assertEqual(self.generate.call_count, 1)
        self.assertEqual(self.payload["_timings"]["reference_cache_hit"], 1)

    def test_empty_references_and_worker_release_clear_the_entry(self):
        self.load()
        self.assertIsNone(self.load(references=[]))
        self.assertNotIn("speaker_reference_centroids", self.cache)
        self.load()
        self.cache.clear()
        count = self.generate.call_count
        self.load()
        self.assertEqual(self.generate.call_count, count + 1)


if __name__ == "__main__":
    unittest.main()
