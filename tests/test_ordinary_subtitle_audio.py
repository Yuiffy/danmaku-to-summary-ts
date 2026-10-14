import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/scripts/python'))
from ordinary_subtitle_audio import validate_request, analyze, decode_speech_blocks
from src.scripts.ordinary_subtitle_evidence import digest, validate_subtitle_audio_evidence


class OrdinarySubtitleAudioTests(unittest.TestCase):
    def request(self):
        return {'version': 1, 'settings': {'model': 'nano', 'sensevoiceModel': 'sensevoice', 'use_itn': False},
                'windows': [{'id': 'A1', 'start': 100, 'end': 112}]}

    def test_bounded_unprompted_pair_rejects_invalid_windows_and_word_hints(self):
        validate_request(self.request())
        for mutation in ['long', 'duplicate', 'id', 'nonfinite', 'boolean', 'hotwords', 'prompt', 'itn', 'same_model']:
            request = self.request()
            if mutation == 'long': request['windows'][0]['end'] = 131
            if mutation == 'duplicate': request['windows'] *= 2
            if mutation == 'id': request['windows'][0]['id'] = '../A1'
            if mutation == 'nonfinite': request['windows'][0]['end'] = float('nan')
            if mutation == 'boolean': request['windows'][0]['start'] = True
            if mutation == 'hotwords': request['settings']['hotwords'] = ['预期']
            if mutation == 'prompt': request['settings']['initial_prompt'] = '预期'
            if mutation == 'itn': request['settings']['use_itn'] = True
            if mutation == 'same_model': request['settings']['sensevoiceModel'] = 'nano'
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): validate_request(request)

    def test_an_existing_asr_lease_is_not_overwritten_or_interrupted(self):
        with tempfile.TemporaryDirectory() as directory:
            lease = Path(directory) / 'active.json'; lease.write_text('existing game subtitle task')
            prepare = Mock()
            runtime = SimpleNamespace(prepare_asr_runtime=prepare, GpuThrottle=Mock(), _resource_claim_file=lambda _: lease)
            with patch.dict(sys.modules, {'sensevoice_runtime': runtime}), patch('ordinary_subtitle_audio.check_source'):
                with self.assertRaisesRegex(RuntimeError, 'lease is active'):
                    analyze({**self.request(), 'source': {}}, Path(directory) / 'audio.json')
            prepare.assert_not_called()
            self.assertEqual(lease.read_text(), 'existing game subtitle task')

    def test_speech_after_a_long_pause_is_decoded_instead_of_lost_in_one_window(self):
        samples = [1] * 16000 + [0] * 96000 + [2] * 16000
        def infer(chunk):
            # A whole-window decoder can stop at the first silence; each speech block must reach it.
            word = '前一句' if 1 in chunk else '后一句'
            return [{'text': '<|zh|>' + word}]
        self.assertEqual(infer(samples)[0]['text'], '<|zh|>前一句')
        result = decode_speech_blocks(samples, [[0, 1000], [7000, 8000]], infer)
        self.assertEqual(''.join(row['text'] for row in result), '前一句后一句')
        self.assertEqual([(row['start'], row['end']) for row in result], [(0, 1.2), (6.8, 8)])

    def test_overlapping_vad_padding_does_not_repeat_words(self):
        infer = Mock(return_value=[{'text': '连续讲话'}])
        result = decode_speech_blocks([0] * 48000, [[100, 1000], [1200, 2500]], infer)
        self.assertEqual(''.join(row['text'] for row in result), '连续讲话')
        self.assertEqual(infer.call_count, 1)

    def test_invalid_intervals_and_missing_decode_results_do_not_form_evidence(self):
        for intervals in ([[False, 500]], [[-1, 500]], [[0, 2000]], [[0, float('nan')]], [[600, 900], [0, 100]]):
            with self.subTest(intervals=intervals), self.assertRaises(ValueError):
                decode_speech_blocks([0] * 16000, intervals, Mock())
        with self.assertRaisesRegex(ValueError, 'decode is incomplete'):
            decode_speech_blocks([0] * 16000, [[0, 1000]], Mock(return_value=[]))

    def proof(self, root):
        files = {name: root / name for name in ('request.json', 'audio.json', 'proof.json', 'A1.wav', 'corrected.srt')}
        files['A1.wav'].write_bytes(b'original audio')
        files['corrected.srt'].write_text('预期', encoding='utf-8')
        request = {'requestSha256': 'request-code-bound', 'source': {'mediaPath': 'source'}}
        checks = [{'id': 'A1', 'audioPath': str(files['A1.wav']), 'audioSha256': digest(files['A1.wav']),
                   'decodes': [{'model': model, 'text': '没有这种被凶的预期', 'prompted': False, 'hotwords': [], 'useItn': False}
                               for model in ('nano', 'sensevoice')]}]
        files['request.json'].write_text(json.dumps(request), encoding='utf-8')
        files['audio.json'].write_text(json.dumps({**request, 'windows': checks}), encoding='utf-8')
        proof = {'version': 1, 'authority': 'automatic', 'method': 'unprompted_two_model_consensus', 'source': {'srtSha256': 'source'},
                 'requestPath': str(files['request.json']), 'requestSha256': digest(files['request.json']),
                 'evidencePath': str(files['audio.json']), 'evidenceSha256': digest(files['audio.json']), 'checks': checks,
                 'correctedSrtPath': str(files['corrected.srt']), 'correctedSrtSha256': digest(files['corrected.srt']),
                 'edits': [{'from': '预气', 'to': '预期', 'index': 49}]}
        files['proof.json'].write_text(json.dumps(proof), encoding='utf-8')
        metadata = {'output': {'srtPath': str(files['corrected.srt'])}, 'automaticSubtitleRepair': {
            **proof, 'proofPath': str(files['proof.json']), 'proofSha256': digest(files['proof.json']), 'resultIdentity': 'result'}}
        return metadata, files

    def test_upload_boundary_binds_audio_proof_edit_plan_source_and_rendered_srt(self):
        with tempfile.TemporaryDirectory() as directory:
            original, files = self.proof(Path(directory))
            self.assertEqual(validate_subtitle_audio_evidence(original, {'srtSha256': 'source'}), digest(files['proof.json']))
            for field in ('source', 'edits', 'authority'):
                changed = copy.deepcopy(original)
                changed['automaticSubtitleRepair'][field] = None
                with self.subTest(field=field), self.assertRaises(ValueError):
                    validate_subtitle_audio_evidence(changed, {'srtSha256': 'source'})
            files['A1.wav'].write_bytes(b'changed audio')
            with self.assertRaisesRegex(ValueError, 'model evidence changed'):
                validate_subtitle_audio_evidence(original, {'srtSha256': 'source'})


if __name__ == '__main__':
    unittest.main()
