import asyncio
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from src.scripts.stream_activity_review import approve, validate_activity_review
from src.scripts.clip_upload_manifest import load_upload_manifest
from src.scripts.clip_qa import validate_metadata_qa
from src.scripts import batch_upload
from src.scripts import clip_upload_registry as registry
from src.scripts.stream_activity_collections import ensure_collections


class ActivityUploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.media = self.root / 'recording.flv'
        self.srt = self.root / 'recording.srt'
        self.cover = self.root / 'cover.jpg'
        for p in (self.media, self.srt, self.cover):
            p.write_bytes(b'fixture')
        self.parts = []
        for i in range(3):
            p = self.root / f'P{i+1}.mp4'
            p.write_bytes(f'part-{i}'.encode())
            self.parts.append({'activityId': 'a1', 'title': f'影片 {i+1}/3', 'mediaPath': str(p),
                'start': i*1500, 'end': (i+1)*1500, 'duration': 1500, 'actualDuration': 1500,
                'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()})
        self.metadata = self.root / 'watch.json'
        self.manifest = self.root / 'UPLOAD_MANIFEST.json'
        self.data = {'version': 1, 'type': 'stream_activity_submission', 'kind': 'watch', 'planSignature': 'plan',
            'sourceSnapshot': {'mediaPath': str(self.media), 'mediaBytes': str(self.media.stat().st_size),
                'mediaMtimeNs': str(self.media.stat().st_mtime_ns), 'srtPath': str(self.srt),
                'srtSha256': hashlib.sha256(self.srt.read_bytes()).hexdigest()},
            'source': {'mediaPath': str(self.media), 'srtPath': str(self.srt)},
            'coverage': {'status': 'complete', 'duration': 4500, 'windows': [{'start': 0, 'end': 4500, 'status': 'inspected'}]},
            'activities': [{'id': 'a1', 'kind': 'watch', 'start': 0, 'end': 4500}],
            'window': {'start': 0, 'end': 4500, 'duration': 4500},
            'copy': {'title': '本场同步视听', 'description': '原始音画，完整连续分P', 'coverText': '同步视听'},
            'output': {'parts': self.parts, 'mediaPath': self.parts[0]['mediaPath'], 'coverPath': str(self.cover), 'metadataPath': str(self.metadata)},
            'coverSha256': hashlib.sha256(self.cover.read_bytes()).hexdigest(), 'uploadReady': False,
            'activityReview': {'status': 'pending'}, 'upload': {'prefix': '【小岁】', 'tags': ['同步视听'], 'tid': 21,
                'roomId': '25788785', 'collectionSectionId': 222}}
        self.save()
        self.manifest.write_text(json.dumps({'type': 'bilibili_clip_upload_manifest', 'clips': [{'metadataPath': str(self.metadata)}]}), encoding='utf-8')

    def save(self):
        self.metadata.write_text(json.dumps(self.data, ensure_ascii=False), encoding='utf-8')

    def approved(self):
        approve(self.metadata, '已检查实际观看与完整边界')
        return json.loads(self.metadata.read_text(encoding='utf-8'))

    def test_pending_approval_does_not_authorize_upload_and_manifest_is_one_archive(self):
        with self.assertRaisesRegex(ValueError, 'need review'):
            load_upload_manifest(self.manifest)
        rows = load_upload_manifest(self.manifest, allow_pending_review=True)
        self.assertEqual(len(rows), 1)
        self.assertEqual(len(rows[0]['parts']), 3)
        self.assertTrue(rows[0]['reviewPending'])
        self.approved()
        rows = load_upload_manifest(self.manifest)
        self.assertFalse(rows[0]['reviewPending'])
        self.assertEqual(rows[0]['collectionSectionId'], 222)

    def test_every_P_and_order_are_bound_to_review(self):
        data = self.approved()
        validate_metadata_qa(data)
        for mutate in (lambda x: x['output']['parts'].reverse(), lambda x: x['copy'].update(title='另一个标题'),
                       lambda x: x['upload'].update(collectionSectionId=333)):
            changed = copy.deepcopy(data)
            mutate(changed)
            with self.assertRaisesRegex(ValueError, 'changed after review'):
                validate_activity_review(changed)
        Path(self.parts[2]['mediaPath']).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'P changed'):
            validate_activity_review(data)

    def test_repaired_detection_transcript_remains_bound_to_review(self):
        transcript = self.root / 'ALIGNED.srt'
        transcript.write_text('原音频重新对齐的字幕', encoding='utf-8')
        self.data['transcript'] = {'path': str(transcript), 'sha256': hashlib.sha256(transcript.read_bytes()).hexdigest(),
            'mode': 'repaired_source_audio'}
        self.save()
        approved = self.approved()
        transcript.write_text('changed', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'transcript changed'):
            validate_activity_review(approved)

    def test_visual_title_evidence_and_source_frame_remain_bound_to_review(self):
        frame = self.root / 'frame.jpg'
        frame.write_bytes(b'original source frame')
        self.data['presentation'] = {'titleEvidence': {'name': '测试电影', 'activityId': 'a1',
            'framePath': str(frame), 'frameSha256': hashlib.sha256(frame.read_bytes()).hexdigest(),
            'method': 'source_frame_reading', 'note': '源画面明确显示作品标题'}}
        self.save()
        approved = self.approved()
        changed = copy.deepcopy(approved)
        changed['presentation']['titleEvidence']['name'] = '另一个作品'
        with self.assertRaisesRegex(ValueError, 'changed after review'):
            validate_activity_review(changed)
        frame.write_bytes(b'another source frame')
        with self.assertRaisesRegex(ValueError, 'title evidence changed'):
            validate_activity_review(approved)

    def test_gaps_and_overlong_parts_reject_approval(self):
        self.data['output']['parts'][1]['start'] += 1
        self.data['output']['parts'][1]['duration'] -= 1
        self.data['output']['parts'][1]['actualDuration'] -= 1
        self.save()
        with self.assertRaisesRegex(ValueError, 'gap'):
            self.approved()
        self.data['output']['parts'][1].update(start=1500, end=3400, duration=1900, actualDuration=1900)
        self.save()
        with self.assertRaisesRegex(ValueError, '30 minutes'):
            self.approved()

    @patch('bilibili_upload_capabilities.fetch_capabilities', return_value={
        'maxParts': 100, 'collectionAllowed': True, 'multipartCollectionAllowed': True, 'externalSubtitlesAllowed': False,
        'maxFileBytes': 16*1024**3, 'maxVideoSeconds': 10800})
    @patch('bilibili_upload_capabilities.load_cookie', return_value='fixture')
    @patch.object(batch_upload.video_uploader, 'VideoUploader')
    @patch.object(batch_upload.video_uploader, 'VideoUploaderPage')
    @patch.object(batch_upload.video_uploader, 'VideoMeta')
    @patch.object(batch_upload.Picture, 'from_file')
    @patch.object(batch_upload, 'validate_video_stream', return_value=(True, ''))
    def test_multipart_uploader_submits_once_with_all_pages_in_order(self, valid, picture, meta, page, uploader, cookie, capabilities):
        self.approved()
        clip = load_upload_manifest(self.manifest)[0]
        uploader.return_value.start = AsyncMock(return_value={'bvid': 'BV1TEST', 'aid': 111})
        result = asyncio.run(batch_upload.upload_one(clip, object(), clip['prefix'], clip['tags'], 21, ''))
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(page.call_count, 3)
        self.assertEqual([call.kwargs['path'] for call in page.call_args_list], [p['mediaPath'] for p in self.parts])
        uploader.return_value.start.assert_awaited_once()
        self.assertEqual(len(uploader.call_args.kwargs['pages']), 3)
        self.assertEqual(meta.call_args.kwargs['desc'], self.data['copy']['description'])

    @patch('bilibili_upload_capabilities.fetch_capabilities', return_value={
        'maxParts': 1, 'collectionAllowed': True, 'multipartCollectionAllowed': True, 'externalSubtitlesAllowed': True,
        'maxFileBytes': 16*1024**3, 'maxVideoSeconds': 10800})
    @patch('bilibili_upload_capabilities.load_cookie', return_value='fixture')
    @patch.object(batch_upload.video_uploader, 'VideoUploader')
    def test_closed_multipart_permission_preserves_bundle_without_submitting_pages(self, uploader, cookie, capabilities):
        self.approved()
        clip = load_upload_manifest(self.manifest)[0]
        result = asyncio.run(batch_upload.upload_one(clip, object(), clip['prefix'], clip['tags'], 21, ''))
        self.assertEqual(result['status'], 'capability_blocked')
        self.assertIn('multipart permission unavailable', result['error'])
        uploader.assert_not_called()
        self.assertEqual(len(load_upload_manifest(self.manifest)[0]['parts']), 3)

    @patch.object(batch_upload, 'fetch_member_archives', return_value={})
    @patch.object(batch_upload, 'wait_for_upload_available', new_callable=AsyncMock, return_value=(True, ''))
    @patch.object(batch_upload, 'upload_one', new_callable=AsyncMock, return_value={'status': 'ok', 'bvid': 'BV1TEST'})
    @patch.object(batch_upload, 'enrich_upload_result', side_effect=lambda x, _: x)
    @patch.object(batch_upload, 'attach_video_to_collection', new_callable=AsyncMock)
    def test_activity_collection_override_beats_ordinary_sui_route(self, attach, enrich, upload, wait, archives):
        self.approved()
        clip = load_upload_manifest(self.manifest)[0]
        asyncio.run(batch_upload.upload_one_guarded(clip, object(), '', [], 21, '', '', 30, 0, 9482593))
        self.assertEqual(attach.call_args.kwargs['collection_section_id'], 222)

    @patch.object(registry.subprocess, 'run')
    def test_queue_runs_one_multipart_archive_with_a_long_upload_timeout(self, run):
        self.approved()
        clip = load_upload_manifest(self.manifest)[0]
        clip.update(statePath=str(self.root / 'upload_state.json'), id=100)
        run.return_value.returncode = 0
        run.return_value.stdout = '[OK] uploaded'
        run.return_value.stderr = ''
        result = registry.run_batch([clip], {'timeoutSeconds': 1800})
        self.assertEqual(result.returncode, 0)
        run.assert_called_once()
        self.assertEqual(run.call_args.kwargs['timeout'], 14400)


class ActivityCollectionTests(unittest.TestCase):
    @patch('src.scripts.stream_activity_collections.create_collection_season')
    @patch('src.scripts.stream_activity_collections.list_collection_seasons')
    def test_existing_collections_reused_without_duplicates(self, listing, create):
        listing.return_value = [
            {'season': {'id': 11, 'title': '岁己歌切'}, 'sections': {'sections': [{'id': 111}]}},
            {'season': {'id': 22, 'title': '岁己同步视听'}, 'sections': {'sections': [{'id': 222}]}}]
        result = ensure_collections(object(), apply=True)
        self.assertEqual(result['songs']['sectionId'], 111)
        self.assertEqual(result['watch']['sectionId'], 222)
        create.assert_not_called()


if __name__ == '__main__':
    unittest.main()
