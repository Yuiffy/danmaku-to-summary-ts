import asyncio
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.scripts.precision_publish import validate_revision, precision_public_copy, select_precision
from types import SimpleNamespace
from src.scripts import replace_video as transport


class PrecisionPublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def fixture(self):
        original = self.root / 'original-metadata.json'
        original.write_text('{}', encoding='utf-8')
        directory = self.root / 'revision'
        directory.mkdir()
        (directory / 'original.json').write_bytes(original.read_bytes())
        source = self.root / 'source.mp4'
        source.write_bytes(b'source')
        source_srt = self.root / 'source.srt'
        source_srt.write_bytes(b'evidence')
        output = {}
        for name, key in [('new.mp4', 'mediaPath'), ('new.srt', 'srtPath'), ('new.jpg', 'coverPath')]:
            p = directory / name
            p.write_bytes(name.encode())
            output[key] = str(p)
        sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
        public_copy = {'title': 'title', 'coverText': 'cover', 'description': 'description'}
        hashes = {'video': sha(output['mediaPath']), 'subtitles': sha(output['srtPath']), 'cover': sha(output['coverPath']),
                  'copy': hashlib.sha256('title\0cover\0description'.encode()).hexdigest()}
        metadata = {'mode': 'own_stream_fun_review', 'uploadReady': False, 'qaRequired': True, 'output': output,
                    'copy': public_copy, 'qaResult': {'version': 1, 'status': 'passed', 'digests': hashes},
                    'creativeResult': {'status': 'edited'}, 'audioQa': {'status': 'passed'},
                    'source': {'mediaPath': str(source), 'srtPath': str(source_srt)},
                    'precisionRevision': {'clipId': 17, 'status': 'pending_review', 'originalMetadataPath': str(original),
                        'sourceSnapshot': {'mediaBytes': str(source.stat().st_size), 'mediaMtimeNs': str(source.stat().st_mtime_ns),
                                           'srtSha256': sha(source_srt)}}}
        (directory / 'clip.json').write_text(json.dumps(metadata), encoding='utf-8')
        return {'id': 17, 'metadataPath': str(original)}, directory, metadata

    def test_approval_checks_passed_hashes_without_mutating_reviewed_metadata(self):
        record, directory, metadata = self.fixture()
        before = (directory / 'clip.json').read_bytes()
        validate_revision(record, directory)
        self.assertEqual((directory / 'clip.json').read_bytes(), before)
        Path(metadata['output']['mediaPath']).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'changed after AI'):
            validate_revision(record, directory)

    def test_wrong_id_and_source_changes_are_rejected(self):
        record, directory, metadata = self.fixture()
        with self.assertRaisesRegex(ValueError, 'registered ID'):
            validate_revision({**record, 'id': 18}, directory)
        Path(metadata['source']['srtPath']).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'source subtitles changed'):
            validate_revision(record, directory)

    def test_select_unpublished_revision_preserves_id_and_original_and_rejects_queue_or_publication(self):
        from src.scripts import clip_upload_registry as api
        record, directory, metadata = self.fixture()
        record.update(reviewIndex=4, status='review')
        metadata.update(reviewIndex=4, window={'start': 0, 'end': 10, 'duration': 10})
        (directory / 'clip.json').write_text(json.dumps(metadata), encoding='utf8')
        original = Path(record['metadataPath']).read_bytes()
        registry_path, queue_path = self.root / 'registry.json', self.root / 'queue.json'
        api.save_json(registry_path, {'clips': {'17': record}, 'nextClipId': 18})
        api.save_json(queue_path, {'jobs': []})
        args = SimpleNamespace(id=17, revision=str(directory), review_note='User requests publication')
        with patch.object(api, 'REGISTRY_PATH', registry_path), patch.object(api, 'QUEUE_PATH', queue_path), \
                patch.object(api, 'acquire_queue_mutation_lock', return_value=None), \
                patch.object(api, 'release_queue_mutation_lock'), patch.object(api, 'sync_clip_statuses'):
            select_precision(args, api)
            saved = api.load_json(registry_path, {})
            self.assertEqual(saved['nextClipId'], 18)
            self.assertEqual(saved['clips']['17']['metadataPath'], str(directory / 'publication.json'))
            self.assertEqual(saved['clips']['17']['manifestPath'], str(directory / 'publication.json'))
            self.assertEqual(Path(record['metadataPath']).read_bytes(), original)
            self.assertFalse(json.loads((directory / 'clip.json').read_text())['uploadReady'])
            self.assertEqual(saved['clips']['17']['mediaPath'], metadata['output']['mediaPath'])
            from src.scripts.clip_upload_json import import_json
            imported_args = SimpleNamespace(manifest=record['metadataPath'], source='', tags='', prefix='', tid=21,
                review='', state=str(self.root / 'upload_state.json'), batch_id='', label='', include_pending=False)
            with patch.object(api, 'load_upload_manifest', return_value=[{'metadataPath': record['metadataPath'],
                    'reviewIndex': 4, 'mediaPath': 'old.mp4', 'title': 'old'}]):
                import_json(imported_args, api)
            refreshed = api.load_json(registry_path, {})
            self.assertEqual(refreshed['nextClipId'], 18)
            self.assertEqual(refreshed['clips']['17']['mediaPath'], metadata['output']['mediaPath'])
            with patch.object(api.clip_candidate_queue, 'active_ids', return_value={17}):
                with self.assertRaisesRegex(ValueError, 'queued'):
                    select_precision(args, api)
            saved['clips']['17']['uploadState'] = {'bvid': 'BV_existing'}
            api.save_json(registry_path, saved)
            with self.assertRaisesRegex(ValueError, 'Published'):
                select_precision(args, api)

    def test_transport_never_submits_a_new_post_and_preserves_other_pages(self):
        self.run_transport(False)

    def test_uncertain_edit_is_not_submitted_again(self):
        self.run_transport(True)

    def test_precision_replacement_updates_public_copy_and_binds_it_to_receipt(self):
        self.run_transport(False, precision=True)

    def test_shared_generator_preserves_online_copy_and_uses_actual_audio_offset(self):
        metadata = {'creativeResult': {'status': 'edited'}, 'qaResult': {'status': 'passed'},
            'creativePlan': {'workflow': 'creative', 'duration': 20,
                'effects': [{'start': 2, 'end': 6, 'sound': {'id': 'sitcom_laugh', 'offsetSeconds': 3}}]},
            'audioQa': {'status': 'passed', 'effects': [{'id': 'sitcom_laugh', 'start': 5, 'end': 7.6}]}}
        result = precision_public_copy(metadata, {'title': '【小岁】标题', 'description': '线上原有来源'})
        self.assertEqual(result['title'], '【小岁】标题（AI精切）')
        self.assertIn('线上原有来源', result['description'])
        self.assertIn('00:05.00-00:07.60 后期罐头笑声', result['description'])

    def run_transport(self, fail, precision=False):
        media = self.root / 'new.mp4'
        cover = self.root / 'cover.jpg'
        media.write_bytes(b'video')
        cover.write_bytes(b'cover')
        receipt = self.root / 'receipt.json'
        archive = {'archive': {'bvid': 'BVfixture', 'aid': 1, 'title': 'kept title', 'desc': 'kept desc',
                    'tid': 21, 'tag': 'one,two', 'cover': 'https://example.test/old.jpg', 'copyright': 2, 'source': 'original'},
                   'videos': [{'cid': 10, 'title': 'p1', 'desc': '', 'filename': 'old1'},
                              {'cid': 11, 'title': 'p2', 'desc': '', 'filename': 'old2'}]}
        instances = []

        class Editor:
            def __init__(self, **kw):
                self.meta = kw['meta']
                instances.append(self)

            async def _fetch_configs(self):
                self._VideoEditor__old_configs = archive

            async def _submit(self):
                if fail:
                    raise TimeoutError('unknown edit response')

            async def start(self):
                return await self._main()

        class Uploader:
            def __init__(self, pages, **kw):
                self.pages = pages

            async def _upload_page(self, page):
                return {'filename': 'newfile', 'cid': 99}

            async def _main(self):
                raise AssertionError('Must never use the new-post submission flow')

            async def start(self):
                return await self._main()

        class Video:
            def __init__(self, **kw):
                pass

            async def get_cid(self, index):
                return 11

        base_main = Uploader._main
        with patch.object(transport, 'build_credential', return_value=object()), \
             patch.object(transport.video_uploader, 'VideoEditor', Editor), \
             patch.object(transport.video_uploader, 'VideoUploader', Uploader), \
             patch.object(transport.video_uploader, 'VideoMeta', return_value=object()), \
             patch.object(transport.video_uploader, 'VideoUploaderPage', return_value=object()), \
             patch.object(transport.video, 'Video', Video):
            def transform(current):
                self.assertEqual(current, {'title': 'kept title', 'description': 'kept desc'})
                return {'title': current['title'] + '（AI精切）', 'description': current['description'] + '\n\n【AI精切说明】'}
            call = lambda: asyncio.run(transport.replace_video('BVfixture', str(media), cover_path=str(cover), receipt_path=receipt,
                copy_transform=transform if precision else None))
            if fail:
                with self.assertRaises(TimeoutError):
                    call()
                self.assertEqual(json.loads(receipt.read_text())['status'], 'unknown')
                with self.assertRaisesRegex(ValueError, 'uncertain'):
                    call()
            else:
                result = call()
                self.assertEqual(result['cid'], 99)
                self.assertEqual(result['status'], 'submitted')
                expected = transform({'title': 'kept title', 'description': 'kept desc'}) if precision else {
                    'title': 'kept title', 'description': 'kept desc'}
                self.assertEqual(instances[0].meta['title'], expected['title'])
                self.assertEqual(instances[0].meta['desc'], expected['description'])
                self.assertEqual(result['publicCopy'], expected)
                if precision:
                    self.assertEqual(instances[0].meta['desc_v2'][0]['raw_text'], expected['description'])
                self.assertEqual(instances[0].meta['cover'], archive['archive']['cover'])
                self.assertEqual(instances[0].meta['tag'], 'one,two')
                self.assertEqual(instances[0].meta['videos'][1]['filename'], 'old2')
                self.assertEqual(call()['status'], 'submitted')
        self.assertIs(Uploader._main, base_main)
