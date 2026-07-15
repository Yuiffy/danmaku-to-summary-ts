import os
import sys
import types
import unittest
from unittest.mock import patch


PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PYTHON_SCRIPT_DIR = os.path.join(PROJECT_ROOT, "src", "scripts", "python")
if PYTHON_SCRIPT_DIR not in sys.path:
    sys.path.insert(0, PYTHON_SCRIPT_DIR)

import sensevoice_speaker


class FakeTensor:
    def __init__(self, rows):
        self.rows = list(rows)

    def to(self, _device):
        return self

    @property
    def T(self):
        return self


class FakeFiniteResult:
    def all(self):
        return True


class FakeScalar:
    def __init__(self, value):
        self.value = value

    def max(self):
        return self

    def item(self):
        return self.value


def make_fake_torch():
    module = types.ModuleType("torch")
    module.isfinite = lambda _value: FakeFiniteResult()
    module.cat = lambda tensors, dim=0: FakeTensor(
        [row for tensor in tensors for row in tensor.rows]
    )
    module.matmul = lambda _left, right: FakeScalar(right.score)
    module.nn = types.SimpleNamespace(
        functional=types.SimpleNamespace(normalize=lambda tensor, dim=1: tensor)
    )
    return module


class FakeSpeakerModel:
    def __init__(self):
        self.calls = []

    def generate(self, **kwargs):
        chunks = kwargs["input"]
        self.calls.append(kwargs)
        return [
            {"spk_embedding": FakeTensor([[index]])}
            for index, _chunk in enumerate(chunks)
        ]


class FakeReference(FakeTensor):
    def __init__(self, score):
        super().__init__([[score]])
        self.score = score


class SenseVoiceSpeakerBatchingTests(unittest.TestCase):
    def test_reference_files_are_embedded_in_one_batch_and_max_chunks_does_not_leak(self):
        model = FakeSpeakerModel()
        references = [
            {
                "speaker": "A",
                "audio_path": "a.wav",
                "chunk_s": 1,
                "max_chunks": 1,
            },
            {
                "speaker": "B",
                "audio_path": "b.wav",
                "chunk_s": 1,
            },
        ]
        three_seconds = [0.0] * (3 * 16000)

        with patch.dict(sys.modules, {"torch": make_fake_torch()}), patch(
            "sensevoice_speaker.os.path.exists", return_value=True
        ), patch(
            "sensevoice_speaker.load_audio_16k_mono",
            side_effect=[(three_seconds, 16000), (three_seconds, 16000)],
        ):
            embeddings = sensevoice_speaker.build_speaker_reference_centroids(
                model,
                references,
                "cpu",
                batch_size=32,
            )

        self.assertEqual(len(model.calls), 1)
        self.assertEqual(len(model.calls[0]["input"]), 4)
        self.assertEqual(model.calls[0]["batch_size"], 32)
        self.assertEqual(len(embeddings["A"].rows), 1)
        self.assertEqual(len(embeddings["B"].rows), 3)

    def test_cluster_chunks_are_embedded_in_one_batch_and_grouped_back(self):
        model = FakeSpeakerModel()
        sentence_info = [
            {"spk": 0, "start": 0, "end": 2000},
            {"spk": 1, "start": 2000, "end": 5000},
        ]
        payload = {
            "speaker_min_segment_s": 0.5,
            "speaker_max_segment_s": 1,
            "speaker_cluster_max_chunks": 2,
            "speaker_embedding_batch_size": 7,
        }

        with patch.dict(sys.modules, {"torch": make_fake_torch()}):
            embeddings = sensevoice_speaker.build_cluster_embeddings_from_sentence_info(
                model,
                [0.0] * 50,
                10,
                sentence_info,
                payload,
                "cpu",
            )

        self.assertEqual(len(model.calls), 1)
        self.assertEqual(len(model.calls[0]["input"]), 4)
        self.assertEqual(model.calls[0]["batch_size"], 7)
        self.assertEqual(len(embeddings["SPEAKER_00"].rows), 2)
        self.assertEqual(len(embeddings["SPEAKER_01"].rows), 2)

    def test_cluster_match_reports_top_two_scores_and_unknown_decision(self):
        with patch.dict(sys.modules, {"torch": make_fake_torch()}):
            matches = sensevoice_speaker.classify_speaker_clusters(
                {"SPEAKER_00": FakeTensor([[1.0]])},
                {
                    "A": FakeReference(0.80),
                    "B": FakeReference(0.76),
                },
                threshold=0.45,
                margin_threshold=0.06,
                constrain_to_references=True,
            )

        match = matches["SPEAKER_00"]
        self.assertEqual(match["label"], "UNKNOWN")
        self.assertEqual(match["best_label"], "A")
        self.assertEqual(match["second_label"], "B")
        self.assertAlmostEqual(match["margin"], 0.04)
        self.assertFalse(match["accepted"])


if __name__ == "__main__":
    unittest.main()
