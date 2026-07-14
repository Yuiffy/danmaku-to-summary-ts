import copy
import os
import sys
import unittest

import torch

sys.path.insert(0, os.path.dirname(__file__))

from sensevoice_transcribe import configure_paraformer_devices


class FakeParaformerModel:
    def __init__(self, device):
        self.model = torch.nn.Linear(2, 2).to(device)
        self.vad_model = torch.nn.Linear(2, 2).to(device)
        self.punc_model = torch.nn.Linear(2, 2).to(device)
        self.spk_model = None
        self.kwargs = {"device": str(device)}
        self.vad_kwargs = {"device": str(device)}
        self._base_kwargs_map = {}

    def _store_base_configs(self):
        self._base_kwargs_map = {
            "kwargs": copy.deepcopy(self.kwargs),
            "vad_kwargs": copy.deepcopy(self.vad_kwargs),
        }


class ParaformerDeviceConfigurationTests(unittest.TestCase):
    @unittest.skipUnless(torch.cuda.is_available(), "需要 CUDA 才能验证 ASR GPU + VAD CPU")
    def test_asr_stays_on_cuda_while_vad_moves_to_cpu(self):
        model = FakeParaformerModel("cuda:0")

        configure_paraformer_devices(model, main_device="cuda:0", vad_device="cpu")

        self.assertEqual({str(p.device) for p in model.model.parameters()}, {"cuda:0"})
        self.assertEqual({str(p.device) for p in model.punc_model.parameters()}, {"cuda:0"})
        self.assertEqual({str(p.device) for p in model.vad_model.parameters()}, {"cpu"})
        self.assertEqual(model.kwargs["device"], "cuda:0")
        self.assertEqual(model.vad_kwargs["device"], "cpu")
        self.assertEqual(model._base_kwargs_map["kwargs"]["device"], "cuda:0")
        self.assertEqual(model._base_kwargs_map["vad_kwargs"]["device"], "cpu")


if __name__ == "__main__":
    unittest.main()
