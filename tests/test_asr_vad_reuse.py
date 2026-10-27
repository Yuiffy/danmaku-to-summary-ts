import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/scripts/python'))
from asr_vad_reuse import generate_with_vad


class Audio:
    def __len__(self):
        return 16000


class Model:
    def __init__(self, native=None):
        self.vad_model, self.model, self.punc_model = object(), object(), object()
        self.vad_calls = 0
        self.seen = []
        self.native = native if native is not None else [{'text': '你好', 'timestamp': [[0, 100]]}]

    def inference(self, value, *args, **kwargs):
        if kwargs.get('model') is self.vad_model:
            self.vad_calls += 1
            return [{'key': 'new', 'value': [[0, 100]]}]
        if kwargs.get('model') is self.model:
            return copy.deepcopy(self.native)
        return [{'text': '你好。'}]

    def generate(self, input, **kwargs):
        self.config = kwargs
        vad = self.inference(input, model=self.vad_model)
        self.seen.append(vad)
        self.inference(input, model=self.model)
        self.inference('你好', model=self.punc_model)
        if self.native == [{'text': '你好', 'timestamp': [[0, 100]]}]:
            return [{'text': '你好。', 'timestamp': [[0, 100]],
                     'sentence_info': [{'text': '你好。', 'start': 0, 'end': 100}]}]
        return []


class VadReuseTests(unittest.TestCase):
    def test_reuses_detected_prefix_and_preserves_text_timestamps_and_settings(self):
        model = Model()
        audio = Audio()
        vad = [{'key': 'original', 'value': [[0, 100], [1100, 1200]]}]
        metrics = {}
        config = {'batch_size_s': 600, 'sentence_timestamp': True, 'language': 'auto'}
        result = generate_with_vad(model, audio, vad, metrics=metrics, **config)
        self.assertEqual(model.vad_calls, 0)
        self.assertEqual(model.seen, [[{'key': 'original', 'value': [[0, 100]]}]])
        self.assertEqual(model.config, config)
        self.assertEqual(result, {'text': '你好。', 'timestamp': [[0, 100]],
            'sentence_info': [{'text': '你好。', 'start': 0, 'end': 100}]})
        self.assertEqual(metrics, {'vad_reused': 1})
        self.assertEqual(vad[0]['value'], [[0, 100], [1100, 1200]])
        self.assertNotIn('inference', vars(model))

    def test_only_explicit_native_empty_decodes_can_explain_empty_aggregate(self):
        model = Model([{'key': 'native', 'text': '', 'timestamp': []}])
        metrics = {}
        result = generate_with_vad(model, Audio(), [{'value': [[0, 100]]}], metrics=metrics)
        self.assertEqual(result['text'], '')
        self.assertEqual(metrics, {'vad_reused': 1, 'empty_decoding': 1})

    def test_missing_malformed_partial_or_swallowed_native_output_still_fails(self):
        for native, intervals in (([], [[0, 100]]), ([{}], [[0, 100]]),
                ([{'text': ''}], [[0, 100]]), ([{'text': '原话', 'timestamp': []}], [[0, 100]]),
                ([{'text': '', 'timestamp': []}], [[0, 100], [200, 300]])):
            with self.subTest(native=native, intervals=intervals), self.assertRaises(ValueError):
                generate_with_vad(Model(native), Audio(), [{'value': intervals}])

    def test_empty_committed_prefix_does_not_decode_uncommitted_speech(self):
        model = Model()
        result = generate_with_vad(model, Audio(), [{'value': [[1100, 1200]]}])
        self.assertEqual(result['text'], '')
        self.assertFalse(hasattr(model, 'config'))

    def test_exception_restores_existing_adapter_and_propagates(self):
        model = Model()
        original = model.inference
        model.inference = original
        def fail(**kwargs):
            raise RuntimeError('native failure')
        model.generate = fail
        with self.assertRaisesRegex(RuntimeError, 'native failure'):
            generate_with_vad(model, Audio(), [{'value': [[0, 100]]}])
        self.assertIs(model.inference, original)

    def test_pipeline_mutation_cannot_change_boundary_evidence(self):
        model = Model()
        original = model.generate
        def mutate(input, **kwargs):
            model.inference(input, model=model.vad_model)[0]['value'].clear()
            return original(input, **kwargs)
        model.generate = mutate
        vad = [{'value': [[0, 100]]}]
        generate_with_vad(model, Audio(), vad)
        self.assertEqual(vad, [{'value': [[0, 100]]}])

    def test_without_vad_the_existing_output_validation_is_preserved(self):
        model = Model()
        model.vad_model = None
        expected = {'text': '原话', 'timestamp': [[0, 100]]}
        model.generate = lambda **kwargs: [expected]
        self.assertIs(generate_with_vad(model, Audio(), None), expected)
        model.generate = lambda **kwargs: []
        with self.assertRaises(ValueError):
            generate_with_vad(model, Audio(), None)


if __name__ == '__main__':
    unittest.main()
