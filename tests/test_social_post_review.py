import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from src.scripts.clip_qa import validate_metadata_qa, validate_registry_qa
from src.scripts.clip_upload_manifest import load_upload_manifest
from src.scripts.clip_upload_description import build_desc
from src.scripts.clip_publication_duplicates import duplicate_errors
from src.scripts.social_post_review import validate_speed_revision, validate_social_post_revision


class SocialPostReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.files = {}
        for name in ('image', 'music', 'mediaPath', 'coverPath'):
            file = root / name
            file.write_bytes(name.encode())
            self.files[name] = str(file)
        source = {'image': self.files['image'], 'author': '作者', 'sourceKind': 'social_post'}
        self.metadata = {'type': 'social_post_video', 'publicationKind': 'social_post', 'uploadReady': True,
                         'source': source, 'plan': {'source': {k: v for k, v in source.items() if k != 'sourceKind'},
                                                  'music': {'path': self.files['music']}},
                         'copy': {'title': '微博故事', 'description': '微博来源', 'tags': ['微博']},
                         'window': {'start': 0, 'end': 18, 'duration': 18},
                         'output': {k: self.files[k] for k in ('mediaPath', 'coverPath')},
                         'inputHashes': {'screenshot': self.digest('image'), 'music': self.digest('music')},
                         'upload': {'prefix': '', 'tags': ['微博'], 'source': 'https://weibo.com/detail/123', 'tid': 21}}
        self.metadata['socialPostReview'] = {'version': 1, 'status': 'passed', 'reviewer': 'operator', 'note': 'Inspected actual source, video, audio and copy',
                                            'digests': {'video': self.digest('mediaPath'), 'cover': self.digest('coverPath')},
                                            'evidence': copy.deepcopy({k: self.metadata[k] for k in ('source', 'plan', 'inputHashes', 'copy', 'window', 'upload')})}
        self.manifest = root / 'UPLOAD_MANIFEST.json'

    def digest(self, key):
        return hashlib.sha256(Path(self.files[key]).read_bytes()).hexdigest()

    def save(self):
        self.manifest.write_text(json.dumps(self.metadata, ensure_ascii=False), encoding='utf-8')

    def test_pending_render_cannot_be_imported_as_reviewed(self):
        self.metadata['uploadReady'] = False
        self.save()
        with self.assertRaisesRegex(ValueError, 'completed local'):
            load_upload_manifest(self.manifest)
        clips = load_upload_manifest(self.manifest, allow_pending_review=True)
        self.assertTrue(clips[0]['reviewPending'])
        self.assertTrue(clips[0]['socialReviewRequired'])

    def test_approved_manifest_roundtrips_through_existing_quality_gate(self):
        self.save()
        clips = load_upload_manifest(self.manifest)
        self.assertEqual(validate_registry_qa([clips]), [])
        self.assertEqual(clips[0]['publicationKind'], 'social_post')
        self.assertEqual(clips[0]['srtPath'], '')

    def test_source_music_video_cover_changes_invalidate_review(self):
        for key in ('image', 'music', 'mediaPath', 'coverPath'):
            with self.subTest(key=key):
                file = Path(self.files[key]); before = file.read_bytes(); file.write_bytes(b'changed')
                with self.assertRaises(ValueError):
                    validate_metadata_qa(self.metadata)
                file.write_bytes(before)

    def test_each_comment_page_is_bound_even_when_not_the_primary_screenshot(self):
        page = Path(self.tmp.name) / 'comments.png'; page.write_bytes(b'comments')
        self.metadata['source']['pages'] = [{'image': str(page), 'label': '评论截图', 'comments': [{'author': '观众', 'text': '评论', 'publishedAt': '2026-08-28'}]}]
        self.metadata['plan']['source'] = {k: v for k, v in self.metadata['source'].items() if k != 'sourceKind'}
        self.metadata['inputHashes']['page1'] = hashlib.sha256(page.read_bytes()).hexdigest()
        self.metadata['socialPostReview']['evidence'] = copy.deepcopy({k: self.metadata[k] for k in ('source', 'plan', 'inputHashes', 'copy', 'window', 'upload')})
        validate_metadata_qa(self.metadata)
        page.write_bytes(b'new comment screenshot')
        with self.assertRaisesRegex(ValueError, 'changed after rendering'):
            validate_metadata_qa(self.metadata)

    def test_public_copy_timeline_and_source_changes_invalidate_review(self):
        for key in ('copy', 'window', 'source', 'upload'):
            changed = copy.deepcopy(self.metadata)
            changed[key]['unexpected'] = True
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'changed after review'):
                validate_metadata_qa(changed)

    def test_registry_cannot_remove_review_type_or_replace_copy(self):
        self.save()
        clip = load_upload_manifest(self.manifest)[0]
        for field, value in [('socialReviewRequired', False), ('title', '新标题'), ('publicationKind', 'live_speech')]:
            changed = {**clip, field: value}
            self.assertTrue(validate_registry_qa([[changed]]))
        self.metadata['type'] = 'other'
        self.save()
        self.assertTrue(validate_registry_qa([[clip]]))

    def test_social_description_has_no_fictitious_live_clock(self):
        original = '原文说明\n\n来源：作者 微博\n发布于：2026-08-28'
        result = build_desc('标题', '微博', '00:00:00', '00:00:18', original, source_kind='social_post')
        self.assertEqual(result, original)
        with self.assertRaises(ValueError):
            build_desc('标题', '微博', '00:00:00', '00:00:18', '', source_kind='social_post')

    def test_speed_replacement_binds_original_assets_copy_scenes_and_uniform_timing(self):
        self.metadata['plan']['scenes'] = [{'seconds': 6, 'heading': '问题'}, {'seconds': 12, 'heading': '评论', 'page': 1}]
        keys = ('source', 'plan', 'inputHashes', 'copy', 'window', 'upload')
        self.metadata['socialPostReview']['evidence'] = copy.deepcopy({k: self.metadata[k] for k in keys})
        faster = copy.deepcopy(self.metadata)
        for scene in faster['plan']['scenes']:
            scene['seconds'] /= 2
        faster['window'] = {'start': 0, 'end': 9, 'duration': 9}
        media = Path(self.tmp.name) / 'faster.mp4'; media.write_bytes(b'faster render')
        faster['output']['mediaPath'] = str(media)
        faster['socialPostReview']['digests']['video'] = hashlib.sha256(media.read_bytes()).hexdigest()
        def bind(value):
            value['socialPostReview']['evidence'] = copy.deepcopy({k: value[k] for k in keys})
        bind(faster)
        validate_speed_revision(self.metadata, faster)
        # A user-reviewed reveal may need more time while comments retain their pace.
        reveal = copy.deepcopy(faster)
        reveal['plan']['scenes'][1]['seconds'] = 14
        reveal['window'] = {'start': 0, 'end': 17, 'duration': 17}
        bind(reveal)
        validate_social_post_revision(self.metadata, reveal)
        with self.assertRaisesRegex(ValueError, 'uniformly shorten'):
            validate_speed_revision(self.metadata, reveal)
        changes = [lambda m: m['plan']['scenes'][0].update(seconds=4),
                   lambda m: m['plan']['scenes'][0].update(heading='新内容'),
                   lambda m: m['source'].update(author='另一个作者'),
                   lambda m: m['copy'].update(title='另一个标题'),
                   lambda m: m.update(window={'start': 0, 'end': 10, 'duration': 10}),
                   lambda m: m['output'].update(mediaPath=self.files['mediaPath'])]
        for change in changes:
            changed = copy.deepcopy(faster); change(changed); bind(changed)
            if changed['output']['mediaPath'] == self.files['mediaPath']:
                changed['socialPostReview']['digests']['video'] = self.digest('mediaPath')
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_speed_revision(self.metadata, changed)
        media.write_bytes(b'changed after review')
        with self.assertRaisesRegex(ValueError, 'changed after review'):
            validate_speed_revision(self.metadata, faster)

    def test_same_post_new_duration_and_media_does_not_bypass_duplicate_gate(self):
        new = {'id': 2, 'publicationKind': 'social_post', 'source': 'https://weibo.com/detail/123', 'mediaPath': 'new.mp4', 'duration': '00:00:30'}
        old = {**new, 'id': 1, 'source': 'https://weibo.com/detail/123?from=feed', 'mediaPath': 'old.mp4', 'duration': '00:00:10', 'status': 'uploaded'}
        self.assertTrue(duplicate_errors([new], [old], lambda _: {}))
        other = {**old, 'source': 'https://weibo.com/detail/456'}
        self.assertEqual(duplicate_errors([new], [other], lambda _: {}), [])


if __name__ == '__main__':
    unittest.main()
