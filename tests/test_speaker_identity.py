import os
import sys
import unittest
import hashlib
import json
import wave
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'scripts', 'python'))
from speaker_identity import timeline_from_chunk_labels, interval_speaker_evidence, attach_speaker_evidence
from sensevoice_speaker import smooth_speaker_timeline


def rows(match=None, start=0, end=5, policy='row_verified'):
    return timeline_from_chunk_labels([{'start': start, 'end': end}], [0],
        {'SPEAKER_00': {'label': 'Host', 'accepted': True, 'score': .83,
            'cluster_label_by_default': True, 'reference_support': {'Host': {'support_count': 18}}}},
        [match or {'label': 'UNKNOWN', 'best_label': 'Guest', 'score': .44, 'margin': .02, 'accepted': False}],
        ['Host', 'Guest'], identity_policy=policy)


class SpeakerIdentityTests(unittest.TestCase):
    def test_registered_official_reference_has_portable_provenance_and_matching_audio(self):
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
        with open(os.path.join(root, 'data/asr_speaker_refs/enrollment_candidates/mofu_official_chat.enrollment.json'), encoding='utf-8') as handle:
            enrollment = json.load(handle)
        audio = os.path.join(root, enrollment['audio_path'])
        with open(audio, 'rb') as handle:
            self.assertEqual(hashlib.sha256(handle.read()).hexdigest(), enrollment['sha256'])
        with wave.open(audio, 'rb') as stream:
            self.assertEqual(stream.getnchannels(), 1)
            self.assertEqual(stream.getframerate(), 16000)
            self.assertEqual(stream.getnframes() / stream.getframerate(), 16)
        self.assertEqual(enrollment['source']['ownerUid'], 1125641408)
        self.assertEqual(enrollment['source']['bvid'], 'BV1QesSzzE4z')
        self.assertNotIn(enrollment['source']['bvid'], enrollment['verification']['heldOutSource'])

    def test_exemplar_mode_preserves_distinct_audited_samples_and_is_bounded(self):
        import numpy as np
        import torch
        from sensevoice_speaker import build_speaker_reference_centroids
        refs = [{'speaker': 'Guest', 'audio_path': f'sample{i}.wav', 'preserve_exemplars': True} for i in range(2)]
        with patch('sensevoice_speaker.os.path.exists', return_value=True), \
                patch('sensevoice_speaker.load_audio_16k_mono', return_value=(np.ones(16000), 16000)), \
                patch('sensevoice_speaker._generate_speaker_embeddings', return_value=[torch.tensor([[4., 0.]]), torch.tensor([[0., 5.]])]):
            result = build_speaker_reference_centroids(object(), refs, 'cpu')
        self.assertEqual(tuple(result['Guest'].shape), (2, 2))
        self.assertTrue(torch.allclose(result['Guest'].norm(dim=1), torch.ones(2)))
        with patch('sensevoice_speaker.os.path.exists', return_value=True), \
                patch('sensevoice_speaker.load_audio_16k_mono', return_value=(np.ones(16000), 16000)), \
                patch('sensevoice_speaker._generate_speaker_embeddings', return_value=[torch.tensor([[1., 0.]])]):
            with self.assertRaisesRegex(ValueError, '2-24'):
                build_speaker_reference_centroids(object(), refs[:1], 'cpu')

    def test_cluster_does_not_override_rejected_row(self):
        row = rows()[0]
        self.assertEqual(row['speaker'], 'UNKNOWN')
        self.assertIsNone(row['speaker_score'])
        self.assertEqual(row['speaker_best_label'], 'Guest')
        self.assertEqual(row['speaker_best_score'], .44)
        self.assertEqual(row['speaker_cluster_match']['score'], .83)

    def test_legacy_identity_preserved_with_correct_score_provenance(self):
        row = rows(policy='legacy')[0]
        self.assertEqual(row['speaker'], 'Host')
        self.assertEqual(row['speaker_best_score'], .44)

    def test_new_guest_can_survive_a_host_cluster(self):
        row = rows({'label': 'Guest', 'best_label': 'Guest', 'score': .61, 'margin': .17, 'accepted': True})[0]
        self.assertEqual(row['speaker'], 'Guest')
        self.assertEqual(row['speaker_match_scope'], 'row')

    def test_short_response_stays_unknown(self):
        row = rows({'label': 'Host', 'best_label': 'Host', 'score': .8, 'accepted': True}, end=.8)[0]
        self.assertEqual(row['speaker'], 'UNKNOWN')

    def test_smoothing_cannot_undo_explicit_rejection(self):
        known = {'label': 'Host', 'best_label': 'Host', 'score': .8, 'margin': .2, 'accepted': True}
        timeline = rows(known, end=5) + rows(start=5, end=6) + rows(known, start=6, end=11)
        self.assertEqual(smooth_speaker_timeline(timeline, 10, 12)[1]['speaker'], 'UNKNOWN')

    def test_mixed_window_is_not_a_single_speaker(self):
        host = rows({'label': 'Host', 'best_label': 'Host', 'score': .8, 'accepted': True}, end=5)
        guest = rows({'label': 'Guest', 'best_label': 'Guest', 'score': .7, 'accepted': True}, start=5, end=10)
        result = attach_speaker_evidence({'start': 0, 'end': 10}, host + guest, 'row_verified')
        self.assertEqual(result['speaker'], 'UNKNOWN')
        self.assertEqual(result['speaker_evidence']['status'], 'mixed')
        self.assertEqual(len(result['speaker_evidence']['observations']), 2)

    def test_coverage_and_original_audio_spans_are_preserved(self):
        timeline = rows({'label': 'Host', 'best_label': 'Host', 'score': .8, 'accepted': True})
        evidence = interval_speaker_evidence(1, 3, timeline)
        self.assertEqual(evidence['label'], 'Host')
        self.assertEqual(evidence['observations'][0]['start'], 0)
        self.assertFalse(evidence['identityVerified'])
        self.assertIsNone(interval_speaker_evidence(0, 10, timeline)['label'])


if __name__ == '__main__':
    unittest.main()
