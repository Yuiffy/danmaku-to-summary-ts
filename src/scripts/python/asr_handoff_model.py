"""Only model weights survive a job boundary; recording state never does."""
import copy
import gc
import json
import time


class HandoffModelState:
    def __init__(self):
        self.model = None
        self.key = None
        self.parked = False

    def begin(self, payload):
        from live_asr_cache import model_spec
        key = json.dumps({'spec': model_spec(payload), 'device': payload['device'],
                          'vad_device': payload.get('vad_device') or 'cpu'}, sort_keys=True)
        if key != self.key:
            self.clear()
        self.key = key
        return self.model is not None

    def clear(self):
        self.model = None
        self.key = None
        self.parked = False
        gc.collect()

    def move(self, payload, device):
        from sensevoice_paraformer import configure_paraformer_devices
        # configure_paraformer_devices validates the main modules; it only moves VAD.
        for name in ('model', 'punc_model', 'spk_model'):
            module = getattr(self.model, name, None)
            if module is not None:
                module.to(device)
        for name in ('kwargs', 'punc_kwargs', 'spk_kwargs'):
            kwargs = getattr(self.model, name, None)
            if isinstance(kwargs, dict):
                kwargs['device'] = device
        configure_paraformer_devices(self.model, device, payload.get('vad_device') or 'cpu')

    def get(self, payload, factory):
        began = time.perf_counter()
        load_s = restore_s = 0
        if self.model is None:
            self.model = factory(copy.deepcopy(payload))
            load_s = time.perf_counter() - began
        elif self.parked:
            self.move(payload, payload['device'])
            self.parked = False
            restore_s = time.perf_counter() - began
        return self.model, load_s, restore_s

    def before_finish(self, payload, retain):
        if not retain:
            self.clear()
        elif self.model is not None:
            # Keep reusable weights in RAM while optional speaker/emotion stages
            # use the GPU. The next admitted job transfers them back, without IO.
            self.move(payload, 'cpu')
            self.parked = True
        import torch
        gc.collect()
        if str(payload['device']).startswith('cuda'):
            torch.cuda.empty_cache()
