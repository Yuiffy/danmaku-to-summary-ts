"""Optional speaker work must never consume capacity admitted for text ASR."""
import json
from pathlib import Path
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/scripts/python'))
from asr_speaker_load import speaker_policy_at_finish


class SpeakerLoadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.queue = Path(self.directory.name) / 'queue.json'
        self.policy = {'mode': 'auto', 'enabled': True, 'max_pending_jobs': 3, 'max_wait_s': 900,
                       'queue_file': str(self.queue), 'source_path': str(self.queue.parent / 'current.wav')}
        self.queue.write_text('{"tasks":[]}', encoding='utf-8')

    def test_idle_and_manual_modes(self):
        self.assertTrue(speaker_policy_at_finish(self.policy, 'cuda', {'gpu_idle': True})['enabled'])
        for policy in ({'mode': 'on', 'enabled': True}, {'mode': 'off', 'enabled': False},
                       {'mode': 'auto', 'enabled': False, 'reason': 'queue_backlog'}, {}):
            self.assertEqual(speaker_policy_at_finish(policy, 'cpu', {'gpu_idle': False}), policy)

    def test_busy_cpu_or_game_skips_at_final_admission(self):
        for device, sample in [('cpu', {}), ('cuda', {'gpu_idle': False}), ('cuda', {'game_running': True})]:
            with self.subTest(device=device, sample=sample):
                self.assertEqual(speaker_policy_at_finish(self.policy, device, sample)['reason'], 'resource_busy')

    def test_backlog_can_grow_during_transcription_and_queue_is_not_modified(self):
        self.queue.write_text(json.dumps({'tasks': [{'status': 'pending', 'mediaPath': f'other{i}.wav'}
                                                  for i in range(3)]}), encoding='utf-8')
        before = self.queue.read_bytes()
        self.assertEqual(speaker_policy_at_finish(self.policy, 'cuda')['reason'], 'queue_backlog')
        self.assertEqual(self.queue.read_bytes(), before)

    def test_oldest_wait_counts_only_other_pending_tasks(self):
        self.queue.write_text(json.dumps({'tasks': [
            {'status': 'processing', 'mediaPath': 'active.wav', 'addedTime': 1},
            {'status': 'pending', 'mediaPath': self.policy['source_path'], 'addedTime': 1},
            {'status': 'pending', 'mediaPath': 'other.wav', 'addedTime': 1_100_000}]}), encoding='utf-8')
        result = speaker_policy_at_finish(self.policy, 'cuda', now=2000)
        self.assertEqual((result['reason'], result['pendingJobs'], result['oldestWaitSeconds']), ('queue_wait', 1, 900))

    def test_bad_queue_does_not_invent_load(self):
        self.queue.write_text('broken', encoding='utf-8')
        self.assertTrue(speaker_policy_at_finish(self.policy, 'cuda')['enabled'])
        self.queue.unlink()
        self.assertEqual(speaker_policy_at_finish(self.policy, 'cpu')['reason'], 'resource_busy')

    def test_skipping_avoids_model_load_and_keeps_subtitle_text(self):
        import paraformer_postprocess as module
        auto_model = Mock(side_effect=AssertionError('CAM++ must not load'))
        payload = {'enable_speaker': False, 'spk_model': 'cam++', '_timings': {},
                   'speaker_processing_policy': {**self.policy, 'enabled': False, 'reason': 'queue_backlog'}}
        results = [{'text': '测试文字', 'sentence_info': [{'text': '测试文字', 'start': 0, 'end': 1000}]}]
        with patch.dict(sys.modules, {'funasr': types.SimpleNamespace(AutoModel=auto_model)}), \
             patch.object(module, 'analyze_paraformer_emotions', return_value={}), \
             patch.object(module, 'paraformer_full_text_to_segments', return_value=[{'text': '测试文字', 'start': 0, 'end': 1}]), \
             patch.object(module, 'load_audio_16k_mono', side_effect=AssertionError('No speaker audio read')):
            result = module.postprocess_cached_paraformer(payload, 'fixture.wav', 'cuda', results, {}, None, time.perf_counter())
        auto_model.assert_not_called()
        self.assertEqual(result[0]['text'], '测试文字')
        self.assertEqual(payload['_speaker_processing']['reason'], 'queue_backlog')
        self.assertEqual(payload['_speaker_processing']['status'], 'disabled')


if __name__ == '__main__':
    unittest.main()
