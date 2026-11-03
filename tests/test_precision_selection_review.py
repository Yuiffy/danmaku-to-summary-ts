import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from PIL import Image

from src.scripts import clip_upload_registry as api
from src.scripts.clip_qa import validate_metadata_qa
from src.scripts.precision_publish import select_precision, validate_revision
from src.scripts.precision_selection_review import artifact_digests, prepare_feedback_selection, validate_feedback_artifact


class PrecisionSelectionFeedbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / 'revision'
        self.directory.mkdir()
        self.original = self.root / 'baseline.json'
        self.source = {}
        for key, name in [('mediaPath', 'source.mp4'), ('srtPath', 'source.srt')]:
            file = self.root / name
            file.write_bytes(name.encode())
            self.source[key] = str(file.resolve())
        self.output = {'burnedSubtitles': True}
        for key, name in [('mediaPath', 'clip.mp4'), ('srtPath', 'clip.srt'), ('coverPath', 'cover.jpg')]:
            file = self.directory / name
            file.write_bytes(name.encode())
            self.output[key] = str(file)
        ordinary_srt = self.root / 'ordinary.srt'
        ordinary_srt.write_bytes(b'full ordinary subtitles')
        draft = {'path': str(ordinary_srt), 'sha256': hashlib.sha256(ordinary_srt.read_bytes()).hexdigest(),
                 'revision': 2, 'renderedRevision': 2}
        draft['renderedSha256'] = draft['sha256']
        self.baseline = {'renderedSubtitles': draft, 'attributionRequired': True, 'automaticPublicationRequired': True}
        self.original.write_text(json.dumps(self.baseline), encoding='utf-8')
        (self.directory / 'original.json').write_bytes(self.original.read_bytes())
        stat = Path(self.source['mediaPath']).stat()
        snapshot = {'mediaPath': self.source['mediaPath'], 'mediaBytes': str(stat.st_size),
            'mediaMtimeNs': str(stat.st_mtime_ns), 'srtPath': self.source['srtPath'],
            'srtSha256': hashlib.sha256(Path(self.source['srtPath']).read_bytes()).hexdigest(),
            'xmlPath': None, 'xmlSha256': None}
        self.metadata = {'mode': 'own_stream_fun_review', 'qaRequired': True, 'attributionRequired': False,
            'automaticPublicationRequired': True, 'uploadReady': False, 'renderedSubtitles': copy.deepcopy(draft),
            'reviewIndex': 1, 'window': {'start': 10, 'end': 40, 'duration': 30}, 'source': self.source,
            'copy': {'title': '黄条', 'coverText': '原来还有黄条？\nLT到底在哪！', 'description': '游戏开荒精切'},
            'output': self.output, 'creativeResult': {'status': 'edited'},
            'precisionRevision': {'clipId': 17, 'status': 'pending_review',
                'originalMetadataPath': str(self.original), 'sourceSnapshot': snapshot}}
        self.metadata['qaResult'] = {'version': 1, 'status': 'passed', 'digests': artifact_digests(self.metadata)}
        self.file = self.directory / 'clip.json'
        self.save()
        self.record = {'id': 17, 'reviewIndex': 1, 'status': 'needs_review', 'metadataPath': str(self.original)}
        self.image = self.root / 'generated.png'
        Image.new('RGB', (1280, 720), 'purple').save(self.image)

    def save(self):
        self.file.write_text(json.dumps(self.metadata), encoding='utf-8')

    def test_explicit_selection_validates_edited_srt_without_claiming_it_is_the_ordinary_revision(self):
        before = self.file.read_bytes()
        validate_revision(self.record, self.directory, feedback_authorized=True)
        self.assertEqual(self.file.read_bytes(), before)
        prepared = prepare_feedback_selection(self.metadata, self.directory, '用户看过当前精切并授权投稿', 'now')
        self.assertNotIn('renderedSubtitles', prepared)
        self.assertEqual(prepared['precisionBaselineSubtitles'], self.baseline['renderedSubtitles'])
        self.assertTrue(prepared['attributionRequired'])
        self.assertTrue(prepared['automaticPublicationRequired'])
        self.assertFalse(prepared['ownStreamHumanReview']['audioVisualReviewed'])
        validate_metadata_qa(prepared)
        with self.assertRaises(ValueError):
            validate_revision(self.record, self.directory)

    def test_prepared_cover_gets_new_human_hashes_while_original_ai_approval_stays_unchanged(self):
        before = copy.deepcopy(self.metadata)
        prepared = prepare_feedback_selection(self.metadata, self.directory, '接受生成封面并投稿', 'now', self.image)
        self.assertEqual(self.metadata, before)
        self.assertEqual(prepared['qaResult']['status'], 'superseded_by_human_review')
        self.assertEqual(prepared['qaResult']['digests'], before['qaResult']['digests'])
        self.assertNotEqual(prepared['ownStreamHumanReview']['digests']['cover'], before['qaResult']['digests']['cover'])
        validate_metadata_qa(prepared)
        Path(prepared['output']['coverPath']).write_bytes(b'changed cover')
        with self.assertRaisesRegex(ValueError, 'changed after human review'):
            validate_metadata_qa(prepared)

    def test_unrelated_or_stale_ordinary_subtitle_metadata_is_not_silently_discarded(self):
        for change in ({'revision': 3}, {'path': str(self.image)}):
            metadata = copy.deepcopy(self.metadata)
            metadata['renderedSubtitles'].update(change)
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'baseline subtitle'):
                validate_feedback_artifact(metadata, self.baseline)
        Path(self.baseline['renderedSubtitles']['path']).write_bytes(b'changed baseline')
        with self.assertRaisesRegex(ValueError, 'baseline subtitle'):
            validate_feedback_artifact(self.metadata, self.baseline)

    def test_feedback_rejects_current_artifact_tampering_and_unresolved_render_audio_or_source(self):
        for field in ('mediaPath', 'srtPath', 'coverPath'):
            file = Path(self.output[field])
            before = file.read_bytes()
            file.write_bytes(b'tampered')
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'changed after AI'):
                validate_feedback_artifact(self.metadata, self.baseline)
            file.write_bytes(before)
        for extra in [{'sourceExpansionRequest': {'reason': 'missing ending'}}, {'audioQa': {'status': 'failed'}},
                      {'storyRepairRequest': {'reason': 'incomplete'}}, {'preRenderHold': True}]:
            with self.subTest(extra=extra), self.assertRaisesRegex(ValueError, 'unresolved'):
                validate_feedback_artifact({**self.metadata, **extra}, self.baseline)
        with self.assertRaisesRegex(ValueError, 'passed rendered-media'):
            validate_feedback_artifact({**self.metadata, 'qaResult': {'status': 'failed'}}, self.baseline)
        with self.assertRaisesRegex(ValueError, 'source subtitles changed'):
            Path(self.source['srtPath']).write_bytes(b'changed source')
            validate_revision(self.record, self.directory, feedback_authorized=True)

    def test_feedback_allows_resolved_source_expansion_history(self):
        metadata = copy.deepcopy(self.metadata)
        metadata['creativeResult']['history'] = [
            {'stage': 'source_window_incomplete'},
            {'stage': 'source_expanded'},
            {'stage': 'qa', 'qa': {'approved': True}},
        ]
        validate_feedback_artifact(metadata, self.baseline)

    def test_selection_cli_imports_cover_into_same_id_without_queueing_or_mutating_the_reviewed_revision(self):
        registry, queue = self.root / 'registry.json', self.root / 'queue.json'
        api.save_json(registry, {'clips': {'17': self.record}, 'nextClipId': 18})
        api.save_json(queue, {'jobs': []})
        before = self.file.read_bytes()
        args = api.build_parser().parse_args(['select-precision', '--id', '17', '--revision', str(self.directory),
            '--review-note', '用户看过精切并授权封面和投稿', '--feedback-authorized', '--cover-image', str(self.image)])
        with patch.object(api, 'REGISTRY_PATH', registry), patch.object(api, 'QUEUE_PATH', queue), \
                patch.object(api, 'acquire_queue_mutation_lock', return_value=None), \
                patch.object(api, 'release_queue_mutation_lock'), patch.object(api, 'sync_clip_statuses'):
            self.assertEqual(select_precision(args, api), 0)
        saved = api.load_json(registry, {})
        self.assertEqual(saved['nextClipId'], 18)
        self.assertFalse(saved['clips']['17']['reviewPending'])
        publication = json.loads((self.directory / 'publication.json').read_text('utf-8'))
        validate_metadata_qa(publication)
        self.assertEqual(self.file.read_bytes(), before)
        self.assertEqual(api.load_json(queue, {}), {'jobs': []})

    def test_generated_image_requires_explicit_acceptance_and_valid_image(self):
        for contents in (b'not an image',):
            self.image.write_bytes(contents)
            with self.assertRaises(OSError):
                prepare_feedback_selection(self.metadata, self.directory, '接受封面', 'now', self.image)
        Image.new('RGB', (50, 50)).save(self.image)
        with self.assertRaisesRegex(ValueError, '400x225'):
            prepare_feedback_selection(self.metadata, self.directory, '接受封面', 'now', self.image)
        with self.assertRaisesRegex(ValueError, 'acceptance note'):
            prepare_feedback_selection(self.metadata, self.directory, '', 'now', self.image)


if __name__ == '__main__':
    unittest.main()
