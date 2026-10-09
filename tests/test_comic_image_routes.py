import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "scripts"))

from comic.image_routes import ImageRouteIO, generate_image, _get_image_generation_routes
from config_contract import resolve_generation_modes


class ImageRoutesTest(unittest.TestCase):
    def setUp(self):
        self.metadata = {}
        self.io = ImageRouteIO(
            compatible=Mock(return_value=None),
            images=Mock(return_value="result.png"),
            reset_metadata=self.metadata.clear,
            read_metadata=lambda: dict(self.metadata),
            annotate_metadata=lambda **values: self.metadata.update(values),
            log=Mock(),
        )
        self.routes = [
            {"provider": "primary", "flow": "tuZiCompatible", "maxAttempts": 2, "timeoutMs": 1234},
            {"provider": "fallback", "flow": "openaiImages"},
        ]
        self.config = {
            "aiServices": {},
            "ai": {
                "providers": {
                    name: {"options": {"baseUrl": "https://example.invalid", "apiKey": "test"}}
                    for name in ("primary", "fallback")
                },
                "roomSettings": {"123": {"imageGeneration": {"routes": self.routes}}},
            },
        }

    def test_retries_then_falls_back_preserving_recovery_and_provenance(self):
        def failed(**kwargs):
            self.metadata.update(status="failure", reason="temporary failure")
        self.io.compatible.side_effect = failed
        references = ["host.png", "evidence.jpg"]
        result = generate_image("prompt", references, "123", "recovery.json", config=self.config, io=self.io)
        self.assertEqual(result, "result.png")
        self.assertEqual(self.io.compatible.call_count, 2)
        self.io.images.assert_called_once()
        for attempt in self.io.compatible.call_args_list:
            self.assertEqual(attempt.kwargs["recovery_state_path"], "recovery.json")
            self.assertIs(attempt.kwargs["reference_image_path"], references)
            self.assertEqual(attempt.kwargs["timeout"], 1.234)
        self.assertIs(self.io.images.call_args.kwargs["reference_image_path"], references)
        self.assertEqual(self.metadata["provider"], "fallback")
        self.assertEqual([a["status"] for a in self.metadata["routeAttempts"]], ["failure", "failure", "success"])
        self.assertEqual(self.metadata["routeAttempts"][0]["reason"], "temporary failure")

    def test_total_failure_records_all_attempts_without_calling_unconfigured_provider(self):
        self.config["ai"]["providers"].pop("fallback")
        result = generate_image("prompt", room_id="123", config=self.config, io=self.io)
        self.assertIsNone(result)
        self.io.images.assert_not_called()
        self.assertEqual(self.metadata["status"], "failure")
        self.assertEqual(len(self.metadata["routeAttempts"]), 3)
        self.assertEqual(self.metadata["endpoint"], "imageGenerationRoutes")

    def test_success_does_not_retry_and_retains_provider_metadata(self):
        def success(**kwargs):
            self.metadata.update(endpoint="async", taskId="provider-job", attempts=[{"status": "success"}])
            return "result.png"
        self.io.compatible.side_effect = success
        self.assertEqual(generate_image("prompt", room_id="123", config=self.config, io=self.io), "result.png")
        self.io.compatible.assert_called_once()
        self.io.images.assert_not_called()
        self.assertEqual(self.metadata["taskId"], "provider-job")
        self.assertEqual(self.metadata["endpoint"], "async")

    def test_rollout_picks_once_and_preserves_usage_across_retries(self):
        variant = {"model": "gpt-image-2.5-flare", "quality": "xhigh"}
        self.config['ai']['comic'] = {'imageGeneration': {'rollout': {'enabled': True, 'variants': [variant]}}}
        usage = {'input_tokens': 15, 'output_tokens': 30}
        def respond(**kwargs):
            self.metadata.update(usage=usage, attempts=[{'usage': usage, 'model': kwargs['model']}])
            return None if self.io.images.call_count == 1 else 'result.png'
        self.io.images.side_effect = respond
        with patch('comic.image_routes.random.choice', return_value=variant) as choose:
            self.assertEqual(generate_image('prompt', room_id='123', config=self.config, io=self.io), 'result.png')
        choose.assert_called_once()
        for call in self.io.images.call_args_list:
            self.assertEqual(call.kwargs['quality'], 'xhigh')
            self.assertEqual(call.kwargs['model'], 'gpt-image-2.5-flare')
        self.assertEqual(len(self.metadata['attempts']), 2)
        self.assertTrue(all(a['usage'] == usage for a in self.metadata['attempts']))
        self.assertEqual(self.metadata['quality'], 'xhigh')
        self.assertGreaterEqual(self.metadata['elapsedMs'], 0)
        self.assertEqual(self.metadata['rolloutVariant'], 'gpt-image-2.5-flare:xhigh')

    def test_real_configs_draw_variants_then_retry_image_2_and_preserve_sui(self):
        import json
        root = Path(__file__).resolve().parents[1]
        expected = {('gpt-image-2', 'high')} | {
            (model, quality) for model in ('gpt-image-2.5-flare', 'gpt-image-2.5-sunburst')
            for quality in ('low', 'medium', 'high', 'xhigh', 'max')}
        modes = json.loads((root / 'config' / 'generation-modes.json').read_text(encoding='utf-8'))['modes']
        for name in ('default', 'production'):
            config = resolve_generation_modes(json.loads((root / 'config' / f'{name}.json').read_text(encoding='utf-8')), modes)
            policy = config['ai']['comic']['imageGeneration']
            self.assertTrue(policy['rollout']['enabled'])
            variants = policy['rollout']['variants']
            self.assertEqual({(v['model'], v['quality']) for v in variants}, expected)
            self.assertEqual(len(variants), 11)
            with patch('comic.image_routes.random.choice') as choose:
                routes = _get_image_generation_routes(config, {}, '25788785')
                choose.assert_not_called()
            self.assertEqual([(r['provider'], r['model'], r['flow']) for r in routes], [
                ('daiYu', 'gpt-image-2.5-sunburst', 'openaiImages'),
                ('tuZi', 'gpt-image-2', 'tuZiCompatible'),
                ('daiYu', 'gpt-image-2', 'openaiImages'),
                ('tuZi', 'gpt-image-2', 'tuZiCompatible'),
            ])
            self.assertEqual(routes[0]['quality'], 'max')
            self.assertFalse(routes[1]['includeAsyncFallback'])
            self.assertEqual(routes[-1]['strategyMode'], 'asyncOnly')
            rooms = set(config['ai']['roomSettings']) | {'other', '25034104', None}
            for room in rooms - {'25788785'}:
                for variant in variants:
                    with self.subTest(config=name, room=room, variant=variant):
                        with patch('comic.image_routes.random.choice', return_value=variant) as choose:
                            routes = _get_image_generation_routes(config, {}, room)
                            choose.assert_called_once()
                        self.assertEqual((routes[0]['model'], routes[0]['quality']), (variant['model'], variant['quality']))
                        retry = routes[1]
                        self.assertEqual((retry['provider'], retry['flow']), ('daiYu', 'openaiImages'))
                        self.assertEqual((retry['model'], retry['quality']), ('gpt-image-2', 'high'))
                        self.assertEqual(retry['maxAttempts'], 1)
                        self.assertFalse(retry['useTuziRetry'])
                        self.assertNotIn('rolloutVariant', retry)
                        room_image = config['ai']['roomSettings'].get(room, {}).get('imageGeneration', {})
                        self.assertEqual(routes[2:], room_image.get('routes', policy['routes'])[2:])
                        self.assertEqual(len(routes), 5 if name == 'production' and room == '25034104' else 2)

    def test_global_fallback_runs_once_only_after_failure_without_redrawing(self):
        variants = [
            {'model': 'gpt-image-2.5-sunburst', 'quality': 'max'},
            {'model': 'gpt-image-2.5-flare', 'quality': 'low'},
            {'model': 'gpt-image-2', 'quality': 'high'},
        ]
        self.config['ai']['comic'] = {'imageGeneration': {
            'routes': [
                {'provider': 'primary', 'model': 'gpt-image-2', 'flow': 'openaiImages', 'maxAttempts': 1},
                {'provider': 'fallback', 'model': 'gpt-image-2', 'quality': 'high',
                 'flow': 'openaiImages', 'maxAttempts': 1, 'useTuziRetry': False},
            ],
            'rollout': {'enabled': True, 'variants': variants},
        }}
        references = ['host.png', 'evidence.jpg']
        for variant in variants:
            for responses in (['first.png'], [None, 'recovered.png'], [None, None]):
                with self.subTest(variant=variant, responses=responses):
                    self.io.images.reset_mock()
                    self.io.images.side_effect = responses
                    with patch('comic.image_routes.random.choice', return_value=variant) as choose:
                        result = generate_image('original comic script', references, 'other',
                                                config=self.config, io=self.io)
                        choose.assert_called_once()
                    self.assertEqual(result, responses[-1])
                    self.assertEqual(self.io.images.call_count, len(responses))
                    self.io.compatible.assert_not_called()
                    calls = self.io.images.call_args_list
                    self.assertEqual((calls[0].kwargs['model'], calls[0].kwargs['quality']),
                                     (variant['model'], variant['quality']))
                    for call in calls:
                        self.assertEqual(call.kwargs['prompt'], 'original comic script')
                        self.assertIs(call.kwargs['reference_image_path'], references)
                    if len(calls) == 2:
                        self.assertEqual((calls[1].kwargs['model'], calls[1].kwargs['quality']),
                                         ('gpt-image-2', 'high'))
                        self.assertFalse(calls[1].kwargs['use_tuzi_retry'])
                    self.assertEqual([a['status'] for a in self.metadata['routeAttempts']],
                                     ['success' if value else 'failure' for value in responses])
                    self.assertEqual(self.metadata['rolloutVariant'], f"{variant['model']}:{variant['quality']}")

    def test_sui_502_reaches_backup_and_keeps_original_request(self):
        import json
        root = Path(__file__).resolve().parents[1]
        config = json.loads((root / 'config' / 'production.json').read_text(encoding='utf-8'))
        modes = json.loads((root / 'config' / 'generation-modes.json').read_text(encoding='utf-8'))['modes']
        config = resolve_generation_modes(config, modes)
        config['ai']['providers'] = {
            name: {'options': {'baseUrl': 'https://example.invalid', 'apiKey': 'test'}}
            for name in ('daiYu', 'tuZi')
        }
        config['aiServices'] = {}
        def failed(**kwargs):
            self.metadata.update(status='failure', reason='HTTP 502: Upstream request failed')
        self.io.images.side_effect = failed
        self.io.compatible.return_value = 'recovered.png'
        references = ['host.png', 'evidence.jpg']
        result = generate_image('original comic script', references, '25788785', 'recovery.json', config=config, io=self.io)
        self.assertEqual(result, 'recovered.png')
        self.io.images.assert_called_once()
        self.io.compatible.assert_called_once()
        fallback = self.io.compatible.call_args.kwargs
        self.assertEqual(fallback['prompt'], 'original comic script')
        self.assertIs(fallback['reference_image_path'], references)
        self.assertEqual(fallback['recovery_state_path'], 'recovery.json')
        self.assertFalse(fallback['include_async_fallback'])
        self.assertEqual([a['status'] for a in self.metadata['routeAttempts']], ['failure', 'success'])

    def test_preselected_request_does_not_draw_a_second_variant(self):
        selected = [dict(self.routes[0], flow='openaiImages', model='gpt-image-2.5-sunburst', quality='max')]
        with patch('comic.image_routes._get_image_generation_routes') as choose:
            generate_image('prompt', room_id='123', config=self.config, io=self.io, selected_routes=selected)
            choose.assert_not_called()
        self.assertEqual(self.io.images.call_args.kwargs['quality'], 'max')


if __name__ == "__main__":
    unittest.main()
