import argparse
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from src.scripts import clip_auto_recheck


class AutomaticRecheckTests(unittest.TestCase):
    def api(self, receipt):
        clip = {"id": 7, "status": "needs_review", "metadataPath": "clip.json", "reviewPath": "REVIEW.md", "statePath": "state.json"}
        api = SimpleNamespace(PROJECT_ROOT=Path('.'), REGISTRY_PATH=Path('registry.json'), QUEUE_PATH=Path('queue.json'),
            parse_int_list=lambda value: [int(value)], load_json=lambda *args: {"clips": {"7": clip}}, default_registry=lambda: {},
            hidden_subprocess_kwargs=lambda: {}, import_json=Mock(return_value=0), enqueue=Mock(return_value=0),
            subprocess=SimpleNamespace(run=Mock(return_value=SimpleNamespace(returncode=0, stderr='',
                stdout="PUBLICATION_RECHECK_RESULT: " + json.dumps(receipt))), TimeoutExpired=TimeoutError))
        parser = argparse.ArgumentParser()
        parser.add_argument('command')
        parser.add_argument('--automatic', action='store_true')
        parser.add_argument('--ids')
        api.build_parser = lambda: parser
        return api

    def test_same_id_changed_copy_enqueues_only_via_automatic_policy(self):
        api = self.api({"id": 7, "changed": True, "decision": "auto_queue"})
        self.assertEqual(clip_auto_recheck.recheck_auto(SimpleNamespace(ids='7', enqueue=True), api), 0)
        command = api.subprocess.run.call_args.args[0]
        self.assertIn('recheck_own_publication.js', ' '.join(command))
        self.assertNotIn('approve-review', command)
        self.assertTrue(api.import_json.call_args.args[0].include_pending)
        self.assertTrue(api.enqueue.call_args.args[0].automatic)

    def test_pending_or_missing_receipt_cannot_enqueue(self):
        for receipt in [{"id": 7, "changed": False}, {"id": 7, "changed": True, "decision": "needs_human"}]:
            api = self.api(receipt)
            self.assertEqual(clip_auto_recheck.recheck_auto(SimpleNamespace(ids='7', enqueue=True), api), 0)
            api.enqueue.assert_not_called()
        api = self.api({"id": 8, "changed": True, "decision": "auto_queue"})
        self.assertEqual(clip_auto_recheck.recheck_auto(SimpleNamespace(ids='7', enqueue=True), api), 2)
        api.import_json.assert_not_called()
        api.enqueue.assert_not_called()

    def test_explicit_subtitle_maintenance_uses_the_same_existing_id_command(self):
        api = self.api({"id": 7, "changed": True, "decision": "needs_human"})
        self.assertEqual(clip_auto_recheck.recheck_auto(SimpleNamespace(ids='7', enqueue=True, repair_subtitles=True), api), 0)
        self.assertIn('--repair-subtitles', api.subprocess.run.call_args.args[0])
        api.enqueue.assert_not_called()

    def test_explicit_final_review_refreshes_the_same_id_and_uses_only_automatic_enqueue(self):
        api = self.api({"id": 7, "changed": True, "decision": "auto_queue"})
        self.assertEqual(clip_auto_recheck.recheck_auto(SimpleNamespace(ids='7', enqueue=True, review_final=True), api), 0)
        command = api.subprocess.run.call_args.args[0]
        self.assertIn('--review-final', command)
        self.assertNotIn('--repair-subtitles', command)
        self.assertTrue(api.import_json.call_args.args[0].include_pending)
        self.assertTrue(api.enqueue.call_args.args[0].automatic)

    def test_final_review_and_subtitle_repair_are_mutually_exclusive(self):
        parser = argparse.ArgumentParser()
        clip_auto_recheck.register_commands(parser.add_subparsers(), self.api({}))
        with self.assertRaises(SystemExit):
            parser.parse_args(['recheck-auto', '--ids', '7', '--review-final', '--repair-subtitles'])


if __name__ == '__main__':
    unittest.main()
