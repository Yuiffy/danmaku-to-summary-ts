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

    def test_reference_states_build_independent_supported_prototypes(self):
        import torch

        references = [
            {
                "speaker": "Host",
                "state": "calm",
                "audio_path": "calm.wav",
                "chunk_s": 1,
                "max_chunks": 2,
            },
            {
                "speaker": "Host",
                "state": "excited",
                "audio_path": "excited.wav",
                "chunk_s": 1,
                "max_chunks": 2,
            },
            {
                "speaker": "Host",
                "state": "singleton",
                "audio_path": "singleton.wav",
                "chunk_s": 1,
                "max_chunks": 1,
            },
        ]
        two_seconds = [0.0] * (2 * 16000)
        one_second = [0.0] * 16000
        generated = [
            torch.tensor([[1.0, 0.0]]),
            torch.tensor([[0.99, 0.01]]),
            torch.tensor([[0.0, 1.0]]),
            torch.tensor([[0.01, 0.99]]),
            torch.tensor([[-1.0, 0.0]]),
        ]

        with patch(
            "sensevoice_speaker.os.path.exists",
            return_value=True,
        ), patch(
            "sensevoice_speaker.load_audio_16k_mono",
            side_effect=[
                (two_seconds, 16000),
                (two_seconds, 16000),
                (one_second, 16000),
            ],
        ), patch(
            "sensevoice_speaker._generate_speaker_embeddings",
            return_value=generated,
        ):
            prototypes = sensevoice_speaker.build_speaker_reference_centroids(
                object(),
                references,
                "cpu",
                prototype_merge_threshold=0.5,
                max_prototypes=4,
                prototype_min_support_chunks=2,
            )

        self.assertEqual(int(prototypes["Host"].shape[0]), 2)
        similarities = torch.matmul(
            prototypes["Host"],
            torch.tensor([[1.0, 0.0], [0.0, 1.0]]).T,
        )
        self.assertGreater(float(similarities[:, 0].max().item()), 0.99)
        self.assertGreater(float(similarities[:, 1].max().item()), 0.99)

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
        import torch

        matches = sensevoice_speaker.classify_speaker_clusters(
            {"SPEAKER_00": torch.tensor([[1.0, 0.0], [1.0, 0.0]])},
            {
                "A": torch.tensor([[0.80, 0.0]]),
                "B": torch.tensor([[0.76, 0.0]]),
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
        self.assertEqual(match["support_chunks"], 2)
        self.assertEqual(match["sampled_chunks"], 2)

    def test_cluster_match_rejects_a_single_outlier_hit(self):
        import torch

        matches = sensevoice_speaker.classify_speaker_clusters(
            {
                "SPEAKER_00": torch.tensor([
                    [1.0, 0.0],
                    [0.0, 1.0],
                    [0.0, 1.0],
                ])
            },
            {"A": torch.tensor([[0.9, 0.0]])},
            threshold=0.45,
            margin_threshold=0.06,
            constrain_to_references=True,
            min_support_chunks=2,
        )

        match = matches["SPEAKER_00"]
        self.assertEqual(match["label"], "UNKNOWN")
        self.assertEqual(match["best_label"], "A")
        self.assertEqual(match["support_chunks"], 1)
        self.assertFalse(match["accepted"])

    def test_cluster_match_accepts_repeated_chunk_evidence(self):
        import torch

        matches = sensevoice_speaker.classify_speaker_clusters(
            {
                "SPEAKER_00": torch.tensor([
                    [1.0, 0.0],
                    [0.9, 0.1],
                    [0.0, 1.0],
                ])
            },
            {
                "A": torch.tensor([[0.9, 0.0]]),
                "B": torch.tensor([[0.0, 0.8]]),
            },
            threshold=0.45,
            margin_threshold=0.06,
            constrain_to_references=True,
            min_support_chunks=2,
        )

        match = matches["SPEAKER_00"]
        self.assertEqual(match["label"], "A")
        self.assertEqual(match["support_chunks"], 2)
        self.assertTrue(match["accepted"])

    def test_single_host_fallback_merges_anonymous_clusters_after_host_confirmation(self):
        timeline = [
            {"start": 0, "end": 2, "speaker": "SPEAKER_00", "speaker_score": 0.49},
            {"start": 2, "end": 4, "speaker": "栞栞", "speaker_score": 0.79},
            {"start": 4, "end": 6, "speaker": "UNKNOWN", "speaker_score": None},
        ]
        processing = {}
        matches = {
            "SPEAKER_01": {
                "label": "栞栞",
                "accepted": True,
                "score": 0.79,
            },
            "SPEAKER_00": {
                "label": "SPEAKER_00",
                "best_label": "弥月Mizuki",
                "accepted": False,
                "score": 0.495,
            },
        }

        result = sensevoice_speaker.apply_single_host_speaker_fallback(
            timeline,
            matches,
            processing,
            {
                "speaker_host_label": "栞栞",
                "speaker_single_host_fallback": True,
            },
        )

        self.assertEqual(
            [item["speaker"] for item in result],
            ["栞栞", "栞栞", "栞栞"],
        )
        self.assertEqual(processing["singleHostFallback"]["changedIntervals"], 2)

    def test_single_host_fallback_does_not_hide_confirmed_non_host(self):
        timeline = [{"start": 0, "end": 2, "speaker": "SPEAKER_00"}]
        processing = {}
        matches = {
            "SPEAKER_00": {"label": "栞栞", "accepted": True},
            "SPEAKER_01": {"label": "弥月Mizuki", "accepted": True},
        }

        result = sensevoice_speaker.apply_single_host_speaker_fallback(
            timeline,
            matches,
            processing,
            {
                "speaker_host_label": "栞栞",
                "speaker_single_host_fallback": True,
            },
        )

        self.assertEqual(result[0]["speaker"], "SPEAKER_00")
        self.assertNotIn("singleHostFallback", processing)

    def test_cluster_match_requires_configured_support_ratio(self):
        import torch

        match = sensevoice_speaker.classify_speaker_clusters(
            {
                "SPEAKER_00": torch.tensor([
                    [1.0, 0.0],
                    [1.0, 0.0],
                    [0.0, 1.0],
                    [0.0, 1.0],
                    [0.0, 1.0],
                ])
            },
            {
                "A": torch.tensor([[0.9, 0.0]]),
                "B": torch.tensor([[0.0, 0.4]]),
            },
            threshold=0.45,
            margin_threshold=0.06,
            min_support_chunks=2,
            min_support_ratio=0.5,
        )["SPEAKER_00"]

        self.assertEqual(match["support_chunks"], 2)
        self.assertAlmostEqual(match["support_ratio"], 0.4)
        self.assertFalse(match["accepted"])

    def test_row_match_can_accept_any_reference_speaker(self):
        import torch

        matches = sensevoice_speaker.classify_speaker_rows(
            torch.tensor([
                [1.0, 0.0],
                [0.0, 1.0],
            ]),
            {
                "Host": torch.tensor([
                    [1.0, 0.0],
                    [0.9, 0.1],
                    [0.8, 0.2],
                ]),
                "Guest": torch.tensor([
                    [0.0, 1.0],
                    [0.1, 0.9],
                    [0.2, 0.8],
                ]),
            },
            threshold=0.7,
            margin_threshold=0.2,
            top_k=3,
        )

        self.assertEqual(matches[0]["label"], "Host")
        self.assertTrue(matches[0]["accepted"])
        self.assertEqual(matches[1]["best_label"], "Guest")
        self.assertEqual(matches[1]["label"], "Guest")
        self.assertTrue(matches[1]["accepted"])

    def test_reference_cluster_name_requires_each_row_to_match_same_speaker(self):
        timeline = sensevoice_speaker._timeline_from_chunk_labels(
            [
                {"start": 0.0, "end": 1.0},
                {"start": 1.0, "end": 2.0},
            ],
            [0, 0],
            reference_matches={
                "SPEAKER_00": {
                    "label": "Host",
                    "score": 0.8,
                    "best_label": "Host",
                    "reference_support": {
                        "Host": {"support_count": 2},
                    },
                }
            },
            row_reference_matches=[
                {
                    "label": "Host",
                    "best_label": "Host",
                    "score": 0.75,
                    "accepted": True,
                },
                {
                    "label": "UNKNOWN",
                    "best_label": "Guest",
                    "score": 0.4,
                    "accepted": False,
                },
            ],
            strict_row_reference_labels=["Host"],
        )

        self.assertEqual(timeline[0]["speaker"], "Host")
        self.assertEqual(timeline[0]["speaker_match_scope"], "row")
        self.assertEqual(timeline[1]["speaker"], "SPEAKER_00")
        self.assertEqual(
            timeline[1]["speaker_match_scope"],
            "cluster_rejected_by_row",
        )

    def test_row_reference_name_requires_repeated_cluster_support(self):
        timeline = sensevoice_speaker._timeline_from_chunk_labels(
            [{"start": 0.0, "end": 1.0}],
            [0],
            reference_matches={
                "SPEAKER_00": {
                    "label": "SPEAKER_00",
                    "best_label": "Guest",
                    "reference_support": {
                        "Guest": {"support_count": 1},
                    },
                }
            },
            row_reference_matches=[{
                "label": "Guest",
                "best_label": "Guest",
                "score": 0.72,
                "accepted": True,
            }],
            strict_row_reference_labels=["Guest"],
            row_reference_cluster_min_support_chunks=2,
        )

        self.assertEqual(timeline[0]["speaker"], "SPEAKER_00")
        self.assertEqual(
            timeline[0]["speaker_match_scope"],
            "cluster_rejected_by_row",
        )

    def test_confident_cluster_can_inherit_with_relaxed_row_corroboration(self):
        timeline = sensevoice_speaker._timeline_from_chunk_labels(
            [{"start": 0.0, "end": 1.0}],
            [0],
            reference_matches={
                "SPEAKER_00": {
                    "label": "Host",
                    "best_label": "Host",
                    "accepted": True,
                    "reference_support": {
                        "Host": {"support_count": 4},
                    },
                }
            },
            row_reference_matches=[{
                "label": "UNKNOWN",
                "best_label": "Host",
                "score": 0.51,
                "accepted": False,
            }],
            strict_row_reference_labels=["Host"],
            row_reference_cluster_inherit_threshold=0.45,
        )

        self.assertEqual(timeline[0]["speaker"], "Host")
        self.assertEqual(
            timeline[0]["speaker_match_scope"],
            "cluster_with_row_corroboration",
        )

    def test_reference_embeddings_are_grouped_into_multiple_state_prototypes(self):
        import torch

        prototypes, sizes = (
            sensevoice_speaker.build_speaker_reference_prototypes(
                torch.tensor([
                    [1.0, 0.0],
                    [0.99, 0.01],
                    [0.0, 1.0],
                    [0.01, 0.99],
                ]),
                merge_threshold=0.95,
                max_prototypes=4,
            )
        )

        self.assertEqual(int(prototypes.shape[0]), 2)
        self.assertEqual(sorted(sizes), [2, 2])

    def test_reference_state_prototypes_drop_unsupported_singletons(self):
        import torch

        prototypes, sizes = (
            sensevoice_speaker.build_speaker_reference_prototypes(
                torch.tensor([
                    [1.0, 0.0],
                    [0.99, 0.01],
                    [0.0, 1.0],
                ]),
                merge_threshold=0.95,
                max_prototypes=4,
                min_support_chunks=2,
            )
        )

        self.assertEqual(int(prototypes.shape[0]), 1)
        self.assertEqual(sizes, [2])

    def test_cluster_match_keeps_peak_score_for_downstream_compatibility(self):
        import torch

        matches = sensevoice_speaker.classify_speaker_clusters(
            {
                "SPEAKER_00": torch.tensor([
                    [1.0, 0.0],
                    [0.7, 0.3],
                    [0.0, 1.0],
                ])
            },
            {
                "A": torch.tensor([[0.9, 0.0]]),
                "B": torch.tensor([[0.0, 0.8]]),
            },
            threshold=0.45,
            margin_threshold=0.06,
            constrain_to_references=True,
            min_support_chunks=2,
        )

        match = matches["SPEAKER_00"]
        self.assertTrue(match["accepted"])
        self.assertAlmostEqual(match["score"], 0.9)
        self.assertAlmostEqual(match["support_mean_score"], 0.765)


class SenseVoiceAdaptiveSpeakerTests(unittest.TestCase):
    def test_candidates_preserve_input_boundaries_and_only_cap_long_segments(self):
        candidates = sensevoice_speaker.build_speaker_chunk_candidates(
            [0.0] * 105,
            10,
            [{"start": 0, "end": 10.5}],
        )

        self.assertEqual([(item["start"], item["end"]) for item in candidates], [
            (0.0, 5.2),
            (5.2, 10.5),
        ])

    def test_candidates_use_paraformer_boundaries_inside_vad_segments(self):
        candidates = sensevoice_speaker.build_speaker_chunk_candidates(
            [0.0] * 100,
            10,
            [{"start": 0, "end": 10}],
            boundary_intervals=[
                {"start": 0, "end": 3},
                {"start": 3, "end": 6},
                {"start": 6, "end": 10},
            ],
        )

        self.assertEqual(
            [(item["start"], item["end"]) for item in candidates],
            [(0.0, 3.0), (3.0, 6.0), (6.0, 10.0)],
        )

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

        self.assertEqual([item["index"] for item in first], [0, 1])
        self.assertEqual([item["index"] for item in second], [0, 1])
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

    def test_probe_centroid_assignment_accepts_bounded_stable_partitions(self):
        stable_two = {
            "decision": "multiple",
            "detected_clusters": 2,
            "supported_clusters": 2,
        }
        stable_four = {
            "decision": "multiple",
            "detected_clusters": 4,
            "supported_clusters": 4,
        }
        one_unsupported_noise = {
            "decision": "multiple",
            "detected_clusters": 9,
            "supported_clusters": 8,
        }
        unsupported_noise = {
            "decision": "multiple",
            "detected_clusters": 4,
            "supported_clusters": 2,
        }
        too_many = {
            "decision": "multiple",
            "detected_clusters": 13,
            "supported_clusters": 13,
        }

        self.assertTrue(sensevoice_speaker._should_assign_from_probe_centroids(
            "auto", stable_two
        ))
        self.assertTrue(sensevoice_speaker._should_assign_from_probe_centroids(
            "auto", stable_four
        ))
        self.assertTrue(sensevoice_speaker._should_assign_from_probe_centroids(
            "auto", one_unsupported_noise
        ))
        self.assertFalse(sensevoice_speaker._should_assign_from_probe_centroids(
            "auto", unsupported_noise
        ))
        self.assertFalse(sensevoice_speaker._should_assign_from_probe_centroids(
            "auto", too_many
        ))
        self.assertFalse(sensevoice_speaker._should_assign_from_probe_centroids(
            "always", stable_two
        ))

    def test_assigns_full_embeddings_to_nearest_probe_centroids(self):
        import torch

        probe_embeddings = [
            torch.tensor([[1.0, 0.0]]),
            torch.tensor([[0.9, 0.1]]),
            torch.tensor([[0.0, 1.0]]),
            torch.tensor([[0.1, 0.9]]),
        ]
        full_matrix = torch.tensor([
            [0.8, 0.2],
            [0.2, 0.8],
            [1.0, 0.0],
            [0.0, 1.0],
        ])

        labels = sensevoice_speaker.assign_embeddings_to_probe_centroids(
            full_matrix,
            probe_embeddings,
            [7, 7, 3, 3],
        )

        self.assertEqual(labels, [7, 3, 7, 3])

    def test_refines_probe_centroids_over_the_full_stream_with_fixed_k(self):
        import torch

        labels, metadata = (
            sensevoice_speaker.refine_embeddings_from_probe_centroids(
                torch.tensor([
                    [1.0, 0.0],
                    [0.95, 0.05],
                    [0.9, 0.1],
                    [0.1, 0.9],
                    [0.05, 0.95],
                    [0.0, 1.0],
                ]),
                [
                    torch.tensor([[1.0, 0.0]]),
                    torch.tensor([[0.6, 0.4]]),
                    torch.tensor([[0.0, 1.0]]),
                    torch.tensor([[0.4, 0.6]]),
                ],
                [7, 7, 3, 3],
                max_iterations=8,
            )
        )

        self.assertEqual(labels, [7, 7, 7, 3, 3, 3])
        self.assertEqual(metadata["clusters"], 2)
        self.assertGreaterEqual(metadata["iterations"], 1)

    def test_merges_refined_clusters_above_the_acoustic_threshold(self):
        import torch

        labels, metadata = (
            sensevoice_speaker.merge_speaker_clusters_by_centroid_similarity(
                torch.tensor([
                    [1.0, 0.0],
                    [0.99, 0.01],
                    [0.97, 0.03],
                    [0.96, 0.04],
                    [0.0, 1.0],
                    [0.01, 0.99],
                ]),
                [0, 0, 1, 1, 2, 2],
                merge_threshold=0.95,
            )
        )

        self.assertEqual(labels, [0, 0, 0, 0, 2, 2])
        self.assertEqual(metadata["clusters_before"], 3)
        self.assertEqual(metadata["clusters_after"], 2)
        self.assertEqual(len(metadata["merges"]), 1)
        self.assertGreater(metadata["merges"][0]["score"], 0.95)

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
                [
                    {"start": start, "end": start + 4}
                    for start in range(0, 24, 4)
                ],
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

        reference_matches = {
            "SPEAKER_00": {
                "label": "Alice",
                "score": 0.8,
                "accepted": True,
                "reference_support": {
                    "Alice": {"support_count": 3},
                },
            },
            "SPEAKER_01": {
                "label": "Alice",
                "score": 0.8,
                "accepted": True,
                "reference_support": {
                    "Alice": {"support_count": 3},
                },
            },
        }
        with patch.dict(sys.modules, {"torch": make_fake_torch()}), patch(
            "sensevoice_speaker.assign_embeddings_to_probe_centroids",
            return_value=[0, 0, 0, 1, 1, 1],
        ) as assign_from_probe, patch(
            "sensevoice_speaker.classify_speaker_clusters",
            return_value=reference_matches,
        ), patch(
            "sensevoice_speaker.classify_speaker_rows",
            return_value=[
                {
                    "label": "Alice",
                    "best_label": "Alice",
                    "score": 0.8,
                    "accepted": True,
                }
            ] * 6,
        ):
            result = sensevoice_speaker.run_adaptive_speaker_engine(
                model,
                [0.0] * 240,
                10,
                [
                    {"start": start, "end": start + 4}
                    for start in range(0, 24, 4)
                ],
                payload={
                    "speaker_probe_max_chunks": 4,
                    "speaker_probe_min_valid_chunks": 4,
                    "speaker_probe_min_speech_s": 12,
                    "speaker_probe_min_cluster_s": 8,
                    "speaker_reference_threshold": 0.45,
                    "speaker_full_refine_enabled": False,
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
        self.assertEqual(len(cluster_calls), 2)
        self.assertTrue(all(call["oracle_num"] is None for call in cluster_calls))
        assign_from_probe.assert_called_once()
        self.assertEqual(
            processing["fullClusteringStrategy"],
            "probe_centroid_assignment",
        )
        self.assertEqual(
            processing["full_clustering_strategy"],
            "probe_centroid_assignment",
        )
        self.assertEqual(processing["probeAssignmentClusters"], 2)
        self.assertEqual(len(result["timeline"]), 6)
        self.assertEqual(set(result["reference_matches"]), {"SPEAKER_00", "SPEAKER_01"})
        self.assertTrue(all(item["speaker"] == "Alice" for item in result["timeline"]))

    def test_stable_four_cluster_probe_avoids_full_reclustering(self):
        model = FakeSpeakerModel()
        cluster_calls = []
        stable_labels = [0, 0, 1, 1, 2, 2, 3, 3]

        def clusterer(_embeddings, **kwargs):
            cluster_calls.append(kwargs)
            return stable_labels

        with patch.dict(sys.modules, {"torch": make_fake_torch()}), patch(
            "sensevoice_speaker.assign_embeddings_to_probe_centroids",
            return_value=stable_labels,
        ) as assign_from_probe:
            result = sensevoice_speaker.run_adaptive_speaker_engine(
                model,
                [0.0] * 320,
                10,
                [
                    {"start": start, "end": start + 4}
                    for start in range(0, 32, 4)
                ],
                payload={
                    "speaker_probe_max_chunks": 8,
                    "speaker_probe_min_valid_chunks": 8,
                    "speaker_probe_min_speech_s": 20,
                    "speaker_probe_min_cluster_s": 8,
                    "speaker_probe_max_assignment_clusters": 6,
                    "speaker_full_refine_enabled": False,
                },
                clusterer=clusterer,
            )

        self.assertEqual(result["processing"]["decision"], "multiple")
        self.assertEqual(
            result["processing"]["fullClusteringStrategy"],
            "probe_centroid_assignment",
        )
        self.assertEqual(result["processing"]["probeAssignmentClusters"], 4)
        self.assertEqual(len(cluster_calls), 2)
        assign_from_probe.assert_called_once()

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
                [
                    {"start": start, "end": start + 4}
                    for start in range(0, 16, 4)
                ],
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
        self.assertEqual(
            result["processing"]["fullClusteringStrategy"],
            "full_clustering",
        )

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

        reference_matches = {
            "SPEAKER_00": {"label": "Alice", "score": 0.8},
            "SPEAKER_01": {"label": "Alice", "score": 0.8},
        }
        with patch.dict(sys.modules, {"torch": make_fake_torch()}), patch(
            "sensevoice_speaker.classify_speaker_clusters",
            return_value=reference_matches,
        ):
            result = sensevoice_speaker.run_adaptive_speaker_engine(
                model,
                [0.0] * 160,
                10,
                [
                    {"start": start, "end": start + 4}
                    for start in range(0, 16, 4)
                ],
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
        self.assertEqual(processing["fullClusteringStrategy"], "full_clustering")

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
                [
                    {"start": start, "end": start + 4}
                    for start in range(0, 16, 4)
                ],
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
