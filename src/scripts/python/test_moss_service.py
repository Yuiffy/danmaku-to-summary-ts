import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from moss_service import ManagedMossServer, build_server_command


class MossServiceTests(unittest.TestCase):
    def test_command_pins_model_mount_loopback_gpu_budget_and_hard_lifetime(self):
        with tempfile.TemporaryDirectory() as root:
            model = Path(root) / 'model with spaces'
            model.mkdir()
            (model / 'config.json').write_text('{}')
            payload = {'model': str(model), 'docker_image': 'vllm/vllm-openai@sha256:' + 'a' * 64}
            cmd = build_server_command(payload, 'isolated-test')
            self.assertIn('127.0.0.1::8000', cmd)
            self.assertIn(f'type=bind,source={model.resolve()},target=/model,readonly', cmd)
            self.assertIn('VLLM_USE_V2_MODEL_RUNNER=0', cmd)
            self.assertIn('--kill-after=20', cmd)
            self.assertNotIn('--privileged', cmd)
            accelerated = build_server_command({**payload, 'v2_model_runner': True,
                'wsl2_pin_memory': True, 'docker_image': 'sha256:' + 'b' * 64}, 'isolated-test')
            self.assertIn('VLLM_USE_V2_MODEL_RUNNER=1', accelerated)
            self.assertIn('VLLM_WSL2_ENABLE_PIN_MEMORY=1', accelerated)
            self.assertIn('"length": 4800000', accelerated[-1])
            bounded = build_server_command({**payload, 'max_model_len': 12288,
                'kv_cache_memory_mb': 1536}, 'isolated-test')
            self.assertEqual(bounded[bounded.index('--kv-cache-memory-bytes') + 1], str(1536 * 1024 * 1024))
            with self.assertRaises(ValueError):
                build_server_command({**payload, 'docker_image': 'vllm/vllm-openai:latest'}, 'test')
            with self.assertRaises(ValueError):
                build_server_command({**payload, 'gpu_memory_utilization': float('nan')}, 'test')

    def test_releases_only_its_own_container_on_exit(self):
        server = ManagedMossServer({})
        server.container = 'a' * 64
        with patch.object(server, '_run') as run:
            server.__exit__(RuntimeError, RuntimeError('inference failed'), None)
            run.assert_called_once_with(['docker', 'rm', '--force', 'a' * 64])
            server.close()
            self.assertEqual(run.call_count, 1)


if __name__ == '__main__':
    unittest.main()
