import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/scripts/python'))
from asr_cpu_fallback import apply_cpu_fallback


class CpuFallbackTests(unittest.TestCase):
    def test_only_explicit_admission_changes_device_without_changing_model_or_speaker_policy(self):
        value = {'backend': 'paraformer', 'model': 'my-finetuned-model', 'device': 'cuda',
            'enable_speaker': True, 'speaker_references': [{'speaker': 'sui'}],
            'emotion_analysis': {'enabled': True, 'device': 'cuda'},
            'resource_guard': {'enabled': True, 'game_process_names': ['game.exe']}}
        original = copy.deepcopy(value)
        self.assertFalse(apply_cpu_fallback(value, {}))
        self.assertEqual(value, original)
        env = {'ASR_CPU_FALLBACK': '1'}
        self.assertTrue(apply_cpu_fallback(value, env))
        self.assertEqual(value['model'], original['model'])
        self.assertEqual(value['speaker_references'], original['speaker_references'])
        self.assertTrue(value['enable_speaker'])
        self.assertEqual(value['device'], 'cpu')
        self.assertEqual(value['emotion_analysis']['device'], 'cpu')
        self.assertFalse(value['resource_guard']['pause_when_game_running'])
        self.assertFalse(value['resource_guard']['claim_enabled'])
        self.assertEqual(value['resource_guard']['torch_num_threads'], 2)
        self.assertEqual(env['CUDA_VISIBLE_DEVICES'], '')

    def test_gpu_only_backend_fails_instead_of_silently_changing_model(self):
        with self.assertRaisesRegex(ValueError, 'does not support'):
            apply_cpu_fallback({'backend': 'moss_realtime'}, {'ASR_CPU_FALLBACK': '1'})


if __name__ == '__main__':
    unittest.main()
