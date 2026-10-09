import copy
import hashlib
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from tests import test_stream_activity_upload as upload_fixtures
from src.scripts.activity_auto_publication import ready, approve, validate
from src.scripts.stream_activity_review import check_artifacts, content_digest, validate_activity_review


class AutomaticActivityTests(unittest.TestCase):
    def setUp(self):
        self.fixture = upload_fixtures.ActivityUploadTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.data = self.fixture.data
        self.data.update(roomId='25788785', generatedAt='2026-10-05T01:00:00Z', activityAutomaticPublicationRequired=True)
        self.data['activities'][0].update(startObserved=True, endObserved=True, reviewIssues=[], verification={
            'decision': 'keep', 'method': 'independent_local_asr'})
        self.config = {'streamActivityClips': {'enabled': True, 'roomIds': ['25788785'], 'automaticPublication': {
            'mode': 'auto', 'policyVersion': 'stream-activity-v1', 'roomIds': ['25788785'],
            'activatedAt': '2026-10-05T00:00:00Z', 'authorizationNote': 'authorized fixture'}}}
        self.fixture.save()
        local = patch('src.scripts.activity_audio_review.check_local_activity')
        local.start()
        self.addCleanup(local.stop)
        self.proof = self.fixture.root / 'proof.json'

    def approved(self):
        binding = ready(self.data, self.config, check_artifacts, content_digest)
        self.proof.write_text(json.dumps({'binding': binding, 'status': 'passed', 'issues': [],
            'checks': {key: True for key in ('content', 'boundaries', 'titles', 'visuals', 'policy')}}), encoding='utf-8')
        approve(self.fixture.metadata, self.proof, self.config, check_artifacts, content_digest)
        return json.loads(self.fixture.metadata.read_text(encoding='utf-8'))

    def test_current_complete_bundle_is_automatic_and_worker_revalidates_it(self):
        data = self.approved()
        self.assertTrue(data['uploadReady'])
        self.assertEqual(data['activityReview']['authority'], 'automatic')
        self.assertNotIn('note', data['activityReview'])
        validate(data, self.config, check_artifacts, content_digest)
        with patch('src.scripts.config_loader.get_config', return_value=self.config):
            validate_activity_review(data)
        changed = copy.deepcopy(self.config)
        changed['streamActivityClips']['automaticPublication']['mode'] = 'off'
        with self.assertRaises(ValueError):
            validate(data, changed, check_artifacts, content_digest)

    def test_policy_marker_activation_scope_and_complete_boundary_requirements(self):
        mutations = [lambda d: d.update(activityAutomaticPublicationRequired=False), lambda d: d.update(roomId='other'),
            lambda d: d.update(generatedAt='2026-10-04T23:59:59Z'), lambda d: d['activities'][0].update(startObserved=False),
            lambda d: d['activities'][0].update(endObserved=False), lambda d: d['activities'][0].update(reviewIssues=['source_transcript_timing_unreliable']),
            lambda d: d['activities'][0]['verification'].update(decision='uncertain'),
            lambda d: d['activities'][0]['verification'].update(method='native_audio')]
        for mutate in mutations:
            data = copy.deepcopy(self.data)
            mutate(data)
            with self.subTest(data=data), self.assertRaises(ValueError):
                ready(data, self.config, check_artifacts, content_digest)

    def test_current_copy_parts_policy_and_proof_cannot_change_after_automatic_review(self):
        data = self.approved()
        for mutate in (lambda d: d['copy'].update(title='changed'), lambda d: d.update(roomId='other'),
                       lambda d: d['activityReview'].update(authority='unknown'), lambda d: d.update(uploadReady=False)):
            changed = copy.deepcopy(data)
            mutate(changed)
            with self.assertRaises(ValueError):
                validate(changed, self.config, check_artifacts, content_digest)
        self.proof.write_text('{}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'proof changed'):
            validate(data, self.config, check_artifacts, content_digest)

    def test_enclosing_context_allows_inexact_musical_onset_only_after_provenance_validation(self):
        event = self.data['activities'][0]
        event.update(startObserved=False, endObserved=False,
            reviewIssues=['start_boundary_unconfirmed', 'end_boundary_unconfirmed'])
        event['verification']['boundaryPolicy'] = 'complete_context_enclosure'
        ready(self.data, self.config, check_artifacts, content_digest)
        with patch('src.scripts.activity_audio_review.check_local_activity', side_effect=ValueError('unclosed original context')):
            with self.assertRaisesRegex(ValueError, 'unclosed original context'):
                ready(self.data, self.config, check_artifacts, content_digest)
        event['reviewIssues'].append('media_verification_unconfirmed')
        with self.assertRaisesRegex(ValueError, 'uncertain'):
            ready(self.data, self.config, check_artifacts, content_digest)

    def test_a_source_or_actual_second_P_change_prevents_approval(self):
        self.fixture.srt.write_bytes(b'changed source')
        with self.assertRaisesRegex(ValueError, 'source evidence changed'):
            self.approved()
        self.data['sourceSnapshot']['srtSha256'] = hashlib.sha256(self.fixture.srt.read_bytes()).hexdigest()
        Path(self.fixture.parts[1]['mediaPath']).write_bytes(b'changed P2')
        with self.assertRaisesRegex(ValueError, 'P changed'):
            ready(self.data, self.config, check_artifacts, content_digest)
