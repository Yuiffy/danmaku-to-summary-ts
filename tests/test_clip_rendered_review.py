import argparse
import subprocess
import unittest
from pathlib import Path
from unittest.mock import Mock

from src.scripts.clip_rendered_review import approve_review


class RenderedReviewTests(unittest.TestCase):
    def fixture(self, **changes):
        args = argparse.Namespace(id=17, review_note='Apply publication feedback',
            title=None, description=None, cover_text=None, source_kind=None, feedback_authorized=False)
        for key, value in changes.items():
            setattr(args, key, value)
        clip = {'id': 17, 'metadataPath': 'clip.json', 'reviewIndex': 1,
            'reviewPath': 'review.md', 'statePath': 'state.json', 'reviewPending': False, 'status': 'review'}
        api = Mock()
        api.subprocess.TimeoutExpired = subprocess.TimeoutExpired
        api.PROJECT_ROOT = Path('workspace')
        api.load_json.side_effect = [{'clips': {'17': clip}}, {'jobs': []}]
        api.clip_candidate_queue.active_ids.return_value = set()
        api.subprocess.run.return_value = subprocess.CompletedProcess([], 0, stdout='reviewed', stderr='')
        api.hidden_subprocess_kwargs.return_value = {}
        api.import_json.return_value = 0
        return args, clip, api

    def test_ready_clip_without_new_feedback_remains_a_noop(self):
        args, _, api = self.fixture()
        self.assertEqual(approve_review(args, api), 0)
        api.subprocess.run.assert_not_called()
        api.import_json.assert_not_called()
        api.release_queue_mutation_lock.assert_called_once()

    def test_ready_clip_applies_explicit_public_copy_through_existing_review(self):
        for field, flag in [('title', '--title'), ('description', '--description'),
                            ('cover_text', '--cover-text'), ('source_kind', '--source-kind')]:
            with self.subTest(field=field):
                value = 'live_speech' if field == 'source_kind' else 'Updated copy'
                args, _, api = self.fixture(**{field: value})
                self.assertEqual(approve_review(args, api), 0)
                command = api.subprocess.run.call_args.args[0]
                self.assertEqual(command[command.index(flag) + 1], value)
                self.assertIn('review_rendered_clip.js', command[1])
                api.import_json.assert_called_once()
                api.release_queue_mutation_lock.assert_called_once()

    def test_feedback_acceptance_is_recorded_even_when_copy_is_unchanged(self):
        args, _, api = self.fixture(feedback_authorized=True)
        self.assertEqual(approve_review(args, api), 0)
        self.assertIn('--feedback-authorized', api.subprocess.run.call_args.args[0])
        api.import_json.assert_called_once()

    def test_active_and_published_clips_still_reject_title_edits(self):
        for status in ['queued', 'uploaded']:
            with self.subTest(status=status):
                args, clip, api = self.fixture(title='Updated title')
                clip['status'] = status
                if status == 'queued':
                    api.clip_candidate_queue.active_ids.return_value = {17}
                self.assertEqual(approve_review(args, api), 2)
                api.subprocess.run.assert_not_called()
                api.import_json.assert_not_called()

    def test_failed_review_does_not_import_copy_or_grant_acceptance(self):
        args, _, api = self.fixture(title='Updated title', feedback_authorized=True)
        api.subprocess.run.return_value = subprocess.CompletedProcess([], 1, stdout='', stderr='Source changed')
        self.assertEqual(approve_review(args, api), 2)
        api.import_json.assert_not_called()
        api.release_queue_mutation_lock.assert_called_once()
