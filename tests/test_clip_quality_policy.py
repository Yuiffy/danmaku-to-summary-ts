import copy
import sys
import unittest
import tempfile
import hashlib
import json
from types import SimpleNamespace
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / 'src' / 'scripts'
sys.path.insert(0, str(SCRIPTS))
from clip_quality_policy import quality_errors
from clip_upload_enqueue import quality_policy_errors, publication_errors
from clip_qa import _file_digest


class ClipQualityPolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = {'clipCuration': {'enabled': True, 'roomIds': ['25788785'], 'includeKeywordTopics': True, 'minScore': 90}}
        self.clip = {'id': 1, 'roomId': '25788785', 'metadataPath': 'clip.json'}
        self.metadata = {'roomId': '25788785', 'source': {'mediaPath': 'source.mp4', 'srtPath': 'source.srt'},
                         'window': {'start': 10, 'end': 20}, 'creativeResult': {'status': 'edited'},
                         'qaResult': {'status': 'passed', 'issues': []}, 'audioQa': {'status': 'passed', 'issues': []},
                         'curation': {'version': 1, 'status': 'original', 'score': 95, 'candidateId': '1', 'inputDigest': 'input',
                                      'sourceWindow': {'start': 10, 'end': 20}, 'sourceMediaPath': 'source.mp4',
                                      'sourceSrtSha256': 'source-hash', 'evidencePath': 'proof.json', 'evidenceSha256': 'proof-hash'}}
        self.proof = {'candidates': [{'id': '1', 'roomId': '25788785', 'start': 10, 'end': 20}],
                      'decisions': [{'candidateId': '1', 'status': 'original', 'inputDigest': 'input', 'score': 95,
                                     'searches': [{'query': '具体话题', 'bvids': []}]}]}

    def errors(self):
        return quality_errors([self.clip], self.policy,
                              lambda file: self.metadata if file == 'clip.json' else self.proof,
                              lambda file: {'source.srt': 'source-hash', 'proof.json': 'proof-hash'}.get(file, 'changed'))

    def test_current_reviewed_precision_and_bound_original_coverage_pass(self):
        self.assertEqual(self.errors(), [])

    def test_ordinary_fallback_and_old_inventory_are_held_even_after_feedback_acceptance(self):
        self.metadata['feedbackPublicationAuthorized'] = True
        for field, value in [('creativeResult', {'status': 'kept_original'}), ('qaResult', {'status': 'pending'}),
                             ('audioQa', {'status': 'failed'}), ('curation', {})]:
            with self.subTest(field=field):
                saved = self.metadata[field]
                self.metadata[field] = value
                self.assertTrue(self.errors())
                self.metadata[field] = saved

    def test_covered_unknown_and_rejected_cannot_be_published(self):
        for status in ['covered', 'needs_review', 'rejected', 'budget']:
            self.metadata['curation']['status'] = status
            self.assertTrue(self.errors())

    def test_window_source_or_report_mutation_cannot_inherit_coverage(self):
        baseline = copy.deepcopy(self.metadata)
        for key, value in [('sourceWindow', {'start': 10, 'end': 21}), ('sourceSrtSha256', 'changed'),
                           ('sourceMediaPath', 'other.mp4'), ('evidenceSha256', 'changed'), ('inputDigest', 'invented')]:
            self.metadata = copy.deepcopy(baseline)
            self.metadata['curation'][key] = value
            self.assertTrue(self.errors(), key)
        self.metadata = baseline
        self.proof['decisions'][0]['status'] = 'covered'
        self.assertTrue(self.errors())

    def test_complete_archives_keep_their_own_contracts(self):
        self.metadata = {'type': 'stream_game_submission'}
        self.assertEqual(self.errors(), [])
        self.metadata = {'type': 'stream_activity_submission', 'kind': 'songs'}
        self.assertEqual(self.errors(), [])

    def test_keyword_sources_share_policy_even_outside_sui_room(self):
        self.clip['roomId'] = self.metadata['roomId'] = 'other'
        self.metadata['publicationKind'] = 'keyword_topic'
        self.metadata['curation'] = {}
        self.assertTrue(self.errors())

    def test_manual_candidate_enqueue_can_render_first_but_worker_still_checks_finished_artifacts(self):
        self.metadata['creativeResult'] = {'status': 'kept_original'}
        api = SimpleNamespace(load_upload_runtime_config=lambda: self.policy,
                              load_json=lambda file, default: self.metadata)
        candidate = {**self.clip, 'pendingCut': True}
        self.assertEqual(publication_errors(api, [candidate], {'clips': {}}, manual_enqueue=True), [])
        self.assertTrue(publication_errors(api, [candidate], {'clips': {}}))

    def test_enqueue_rejects_title_that_exceeds_limit_after_display_prefix(self):
        api = SimpleNamespace(load_upload_runtime_config=lambda: self.policy,
                              load_json=lambda file, default: self.metadata)
        candidate = {**self.clip, 'prefix': '【小岁】', 'title': 'a' * 80, 'pendingCut': True}
        errors = publication_errors(api, [candidate], {'clips': {}}, manual_enqueue=True)
        self.assertTrue(any('including prefix' in error for error in errors))

    def test_explicit_dedicated_manual_queue_keeps_its_existing_approval_contract(self):
        self.metadata = {'mode': 'manual_clip_queue'}
        self.assertEqual(self.errors(), [])

    def test_bound_web_human_choice_releases_ordinary_and_deferred_only_until_artifacts_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = {}
            for name in ['source.mp4', 'source.srt', 'ordinary.mp4', 'clip.srt', 'cover.jpg']:
                paths[name] = root / name
                paths[name].write_text(name, encoding='utf-8')
            source = {'mediaPath': str(paths['source.mp4']), 'srtPath': str(paths['source.srt'])}
            stat = paths['source.mp4'].stat()
            public_copy = {'title': '标题', 'coverText': '封面', 'description': '说明'}
            output = {'mediaPath': str(paths['ordinary.mp4']), 'srtPath': str(paths['clip.srt']),
                      'coverPath': str(paths['cover.jpg']), 'burnedSubtitles': True}
            metadata = {'mode': 'own_stream_fun_review', 'roomId': '25788785', 'source': source,
                        'window': {'start': 10, 'end': 20}, 'output': output, 'copy': public_copy,
                        'uploadReady': True, 'creativeResult': {'status': 'kept_original'},
                        'curation': {'status': 'budget'}, 'ownStreamHumanReview': {
                            'version': 1, 'authority': 'human', 'status': 'approved', 'note': 'Web选择普通版投稿',
                            'clipId': 1, 'artifactWindow': {'start': 10, 'end': 20},
                            'source': {**source, 'mediaBytes': str(stat.st_size), 'mediaMtimeNs': str(stat.st_mtime_ns),
                                       'srtSha256': _file_digest(source['srtPath']), 'xmlPath': None, 'xmlSha256': None},
                            'digests': {'video': _file_digest(output['mediaPath']), 'subtitles': _file_digest(output['srtPath']),
                                        'cover': _file_digest(output['coverPath']), 'copy': hashlib.sha256('\0'.join(
                                            public_copy[key] for key in ('title', 'coverText', 'description')).encode()).hexdigest()}}}
            file = root / 'clip.json'
            api = SimpleNamespace(load_upload_runtime_config=lambda: self.policy,
                                  load_json=lambda path, default: json.loads(Path(path).read_text(encoding='utf-8')))
            clip = {**self.clip, 'metadataPath': str(file)}
            file.write_text(json.dumps(metadata), encoding='utf-8')
            self.assertEqual(quality_policy_errors(api, [clip]), [])
            self.assertTrue(quality_policy_errors(api, [{**clip, 'id': 2}]))
            paths['ordinary.mp4'].write_text('changed', encoding='utf-8')
            self.assertTrue(quality_policy_errors(api, [clip]))

    def test_explicit_precision_choice_checks_id_review_artifacts_and_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['source.mp4', 'source.srt', 'source.xml', 'clip.mp4', 'clip.srt', 'cover.jpg']:
                (root / name).write_text(name, encoding='utf-8')
            source = {key: str(root / name) for key, name in [('mediaPath', 'source.mp4'), ('srtPath', 'source.srt'), ('xmlPath', 'source.xml')]}
            stat = Path(source['mediaPath']).stat()
            output = {key: str(root / name) for key, name in [('mediaPath', 'clip.mp4'), ('srtPath', 'clip.srt'), ('coverPath', 'cover.jpg')]}
            copy_fields = {'title': '精切', 'coverText': '封面', 'description': '说明'}
            digests = {key: _file_digest(output[field]) for key, field in [('video', 'mediaPath'), ('subtitles', 'srtPath'), ('cover', 'coverPath')]}
            digests['copy'] = hashlib.sha256('\0'.join(copy_fields[key] for key in ('title', 'coverText', 'description')).encode()).hexdigest()
            metadata = {'roomId': '25788785', 'mode': 'own_stream_fun_review', 'source': source, 'output': output,
                        'copy': copy_fields, 'qaRequired': True, 'uploadReady': True,
                        'qaResult': {'version': 1, 'status': 'passed', 'digests': digests},
                        'precisionPublicationReview': {'authority': 'user', 'note': '选用精切', 'qaDigests': digests},
                        'precisionRevision': {'clipId': 1, 'uploadAuthorized': True, 'sourceSnapshot': {
                            **source, 'mediaBytes': str(stat.st_size), 'mediaMtimeNs': str(stat.st_mtime_ns),
                            'srtSha256': _file_digest(source['srtPath']), 'xmlSha256': _file_digest(source['xmlPath'])}}}
            api = SimpleNamespace(load_upload_runtime_config=lambda: self.policy, load_json=lambda path, default: metadata)
            self.assertEqual(quality_policy_errors(api, [self.clip]), [])
            self.assertTrue(quality_policy_errors(api, [{**self.clip, 'id': 2}]))
            original = copy.deepcopy(metadata)
            for field in ['precisionPublicationReview', 'precisionRevision']:
                metadata = copy.deepcopy(original)
                metadata[field].clear()
                self.assertTrue(quality_policy_errors(api, [self.clip]))
            for name in ['clip.mp4', 'clip.srt', 'cover.jpg', 'source.srt', 'source.mp4']:
                metadata = copy.deepcopy(original)
                file = root / name
                before = file.read_bytes()
                file.write_bytes(b'changed')
                self.assertTrue(quality_policy_errors(api, [self.clip]), name)
                file.write_bytes(before)
            metadata = copy.deepcopy(original)
            del metadata['source']['xmlPath']
            self.assertTrue(quality_policy_errors(api, [self.clip]))


if __name__ == '__main__':
    unittest.main()
