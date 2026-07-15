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
    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def generate(self, **kwargs):
        chunks = kwargs["input"]
        self.calls.append(kwargs)
        if self.fail:
            raise RuntimeError("embedding failed")
        return [
            {"spk_embedding": FakeTensor([[index]])}
            for index, _chunk in enumerate(chunks)
        ]


class FakeBatchedSpeakerModel(FakeSpeakerModel):
    def generate(self, **kwargs):
        chunks = kwargs["input"]
        self.calls.append(kwargs)
        return {
            "spk_embedding": FakeTensor([[index, index + 1] for index, _ in enumerate(chunks)])
        }


class FakeReference(FakeTensor):
    def __init__(self, score):
        super().__init__([[score]])
        self.score = score


class SenseVoiceSpeakerBatchingTests(unittest.TestCase):
    def test_single_batched_result_is_split_into_one_embedding_per_chunk(self):
        model = FakeBatchedSpeakerModel()

        with patch.dict(sys.modules, {"torch": make_fake_torch()}):
            embeddings = sensevoice_speaker._generate_speaker_embeddings(
                model,
                ["first", "second", "third"],
                batch_size=8,
            )

        self.assertEqual(len(model.calls), 1)
        self.assertEqual(len(embeddings), 3)
        self.assertEqual([embedding.rows for embedding in embeddings], [
            [[0, 1]],
            [[1, 2]],
            [[2, 3]],
        ])

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


class SenseVoiceAdaptiveSpeakerTests(unittest.TestCase):
    def test_candidates_use_default_four_second_chunks_and_one_second_minimum(self):
        candidates = sensevoice_speaker.build_speaker_chunk_candidates(
            [0.0] * 105,
            10,
            [{"start": 0, "end": 10.5}],
        )

        self.assertEqual([(item["start"], item["end"]) for item in candidates], [
            (0.0, 4.0),
            (4.0, 8.0),
            (8.0, 10.5),
        ])

    def test_quantile_sampling_is_deterministic_over_cumulative_speech(self):
        candidates = sensevoice_speaker.build_speaker_chunk_candidates(
            [0.0] * 1040,
            10,
            [
                {"start": 0, "end": 8},
                {"start": 100, "end": 104},
            ],
        )

        first = sensevoice_speaker.select_cumulative_speech_quantiles(candidates, 2)
        second = sensevoice_speaker.select_cumulative_speech_quantiles(candidates, 2)

        self.assertEqual([item["index"] for item in first], [0, 2])
        self.assertEqual([item["index"] for item in second], [0, 2])
        self.assertEqual([item["start"] for item in first], [0.0, 100.0])

    def test_decision_requires_stable_multi_speaker_evidence(self):
        durations = [4.0] * 6
        single = sensevoice_speaker.decide_adaptive_speaker_mode(
            [0] * 6,
            [0] * 6,
            chunk_durations=durations,
        )
        too_short_single = sensevoice_speaker.decide_adaptive_speaker_mode(
            [0] * 5,
            [0] * 5,
            chunk_durations=[4.0] * 5,
        )
        multiple = sensevoice_speaker.decide_adaptive_speaker_mode(
            [0, 0, 0, 1, 1, 1],
            [3, 3, 3, 4, 4, 4],
            chunk_durations=durations,
        )
        inconclusive = sensevoice_speaker.decide_adaptive_speaker_mode(
            [0, 0, 0, 1, 1, 1],
            [0, 0, 1, 1, 1, 0],
            chunk_durations=durations,
        )

        self.assertEqual(single["decision"], "single")
        self.assertEqual(too_short_single["decision"], "inconclusive")
        self.assertEqual(too_short_single["reason"], "insufficient_valid_chunks")
        self.assertEqual(multiple["decision"], "multiple")
        self.assertEqual(inconclusive["decision"], "inconclusive")

    def test_single_decision_skips_full_clustering_and_returns_empty_timeline(self):
        model = FakeSpeakerModel()
        cluster_calls = []

        def clusterer(embeddings, **kwargs):
            cluster_calls.append(kwargs)
            return [0] * len(embeddings.rows)

        reference_calls = []

        def lazy_references():
            reference_calls.append(True)
            return {"Alice": FakeReference(0.8)}

        with patch.dict(sys.modules, {"torch": make_fake_torch()}):
            result = sensevoice_speaker.run_adaptive_speaker_engine(
                model,
                [0.0] * 240,
                10,
                [{"start": 0, "end": 24}],
                references=lazy_references,
                clusterer=clusterer,
            )

        processing = result["processing"]
        self.assertEqual(processing["decision"], "single")
        self.assertEqual(processing["status"], "skipped_single_speaker")
        self.assertFalse(processing["full_run"])
        self.assertEqual(len(model.calls), 1)
        self.assertEqual(len(model.calls[0]["input"]), 6)
        self.assertEqual(result["timeline"], [])
        self.assertEqual(reference_calls, [])
        self.assertTrue(all(call["oracle_num"] is None for call in cluster_calls))
        self.assertEqual(processing["sampledChunks"], 6)
        self.assertEqual(processing["validChunks"], 6)
        self.assertEqual(processing["sampledSpeechSeconds"], 24.0)
        self.assertIn("total_s", processing["timings"])

    def test_multiple_decision_reuses_probes_and_matches_references(self):
        model = FakeSpeakerModel()
        cluster_calls = []

        def clusterer(embeddings, **kwargs):
            cluster_calls.append(kwargs)
            size = len(embeddings.rows)
            return [0, 0, 1, 1] if size == 4 else [0, 0, 0, 1, 1, 1]

        with patch.dict(sys.modules, {"torch": make_fake_torch()}):
            result = sensevoice_speaker.run_adaptive_speaker_engine(
                model,
                [0.0] * 240,
                10,
                [{"start": 0, "end": 24}],
                payload={
                    "speaker_probe_max_chunks": 4,
                    "speaker_probe_min_valid_chunks": 4,
                    "speaker_probe_min_speech_s": 12,
                    "speaker_probe_min_cluster_s": 8,
                    "speaker_reference_threshold": 0.45,
                },
                references={"Alice": FakeReference(0.8)},
                clusterer=clusterer,
            )

        processing = result["processing"]
        self.assertEqual(processing["decision"], "multiple")
        self.assertEqual(processing["status"], "full_completed")
        self.assertTrue(processing["full_run"])
        self.assertEqual(processing["probe_embeddings_reused"], 4)
        self.assertEqual(len(model.calls), 2)
        self.assertEqual([len(call["input"]) for call in model.calls], [4, 2])
        self.assertEqual(len(cluster_calls), 3)
        self.assertTrue(all(call["oracle_num"] is None for call in cluster_calls))
        self.assertEqual(len(result["timeline"]), 6)
        self.assertEqual(set(result["reference_matches"]), {"SPEAKER_00", "SPEAKER_01"})
        self.assertTrue(all(item["speaker"] == "Alice" for item in result["timeline"]))

    def test_inconclusive_decision_continues_to_full_clustering(self):
        model = FakeSpeakerModel()
        call_count = 0

        def clusterer(embeddings, **_kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return [0, 0, 1, 1]
            if call_count == 2:
                return [0, 1, 0, 1]
            return [0, 0, 1, 1]

        with patch.dict(sys.modules, {"torch": make_fake_torch()}):
            result = sensevoice_speaker.run_adaptive_speaker_engine(
                model,
                [0.0] * 160,
                10,
                [{"start": 0, "end": 16}],
                payload={
                    "speaker_probe_min_valid_chunks": 4,
                    "speaker_probe_min_speech_s": 12,
                    "speaker_probe_min_cluster_s": 8,
                },
                clusterer=clusterer,
            )

        self.assertEqual(result["processing"]["decision"], "inconclusive")
        self.assertEqual(result["processing"]["status"], "full_completed")
        self.assertTrue(result["processing"]["full_run"])
        self.assertEqual(len(result["timeline"]), 4)
        self.assertEqual(len(model.calls), 1)
        self.assertEqual(result["processing"]["probe_embeddings_reused"], 4)

    def test_always_mode_bypasses_probe_and_runs_full_clustering(self):
        model = FakeSpeakerModel()
        cluster_calls = []

        def clusterer(embeddings, **kwargs):
            cluster_calls.append(kwargs)
            return [0, 0, 1, 1]

        reference_calls = []

        def lazy_references():
            reference_calls.append(True)
            return {"Alice": FakeReference(0.8)}

        with patch.dict(sys.modules, {"torch": make_fake_torch()}):
            result = sensevoice_speaker.run_adaptive_speaker_engine(
                model,
                [0.0] * 160,
                10,
                [{"start": 0, "end": 16}],
                payload={"speaker_detection_mode": "always"},
                references=lazy_references,
                clusterer=clusterer,
            )

        processing = result["processing"]
        self.assertEqual(processing["mode"], "always")
        self.assertEqual(processing["status"], "full_completed")
        self.assertTrue(processing["full_run"])
        self.assertEqual(processing["sampledChunks"], 0)
        self.assertEqual(len(model.calls), 1)
        self.assertEqual(len(cluster_calls), 1)
        self.assertEqual(reference_calls, [True])
        self.assertEqual(len(result["timeline"]), 4)
        self.assertEqual(set(result["reference_matches"]), {"SPEAKER_00", "SPEAKER_01"})

    def test_probe_error_fail_open_continues_to_full_clustering(self):
        class FailFirstModel(FakeSpeakerModel):
            def generate(self, **kwargs):
                self.calls.append(kwargs)
                if len(self.calls) == 1:
                    raise RuntimeError("probe failed")
                return [
                    {"spk_embedding": FakeTensor([[index]])}
                    for index, _chunk in enumerate(kwargs["input"])
                ]

        model = FailFirstModel()
        with patch.dict(sys.modules, {"torch": make_fake_torch()}):
            result = sensevoice_speaker.run_adaptive_speaker_engine(
                model,
                [0.0] * 160,
                10,
                [{"start": 0, "end": 16}],
                clusterer=lambda embeddings, **_kwargs: [0] * len(embeddings.rows),
            )

        self.assertEqual(result["processing"]["status"], "full_completed")
        self.assertEqual(result["processing"]["decision"], "inconclusive")
        self.assertTrue(result["processing"]["full_run"])
        self.assertEqual(len(result["timeline"]), 4)

    def test_full_failure_returns_failed_metadata(self):
        with patch.dict(sys.modules, {"torch": make_fake_torch()}):
            result = sensevoice_speaker.run_adaptive_speaker_engine(
                FakeSpeakerModel(fail=True),
                [0.0] * 120,
                10,
                [{"start": 0, "end": 12}],
                payload={"speaker_detection_mode": "always"},
                clusterer=lambda _embeddings, **_kwargs: [],
            )

        processing = result["processing"]
        self.assertEqual(result["timeline"], [])
        self.assertEqual(result["reference_matches"], {})
        self.assertEqual(processing["status"], "failed")
        self.assertTrue(processing["full_run"])
        self.assertEqual(processing["error"]["type"], "RuntimeError")
        self.assertIn("embedding failed", processing["error"]["message"])


if __name__ == "__main__":
    unittest.main()
