"""Existing media replacement preserves privacy and human copy/settings."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from src.scripts.clip_media_replace import edit_payload, unchanged_archive, record_replacement


class MediaReplacementTests(unittest.TestCase):
    def setUp(self):
        self.detail = {'archive': {'aid': 123, 'title': '人工改过的标题', 'desc': '人工简介\n切片时间：20:56:41 - 20:56:59（直播开始后第18分钟）',
            'copyright': 2, 'source': '直播切片', 'tag': '标签', 'tid': 21, 'attribute': 0,
            'is_only_self': 1, 'is_space_hidden': 0, 'state': -50, 'cover': 'old-cover'},
            'videos': [{'filename': 'old-file', 'cid': 42, 'title': '原P标题', 'desc': '原P简介'}],
            'replace_check': {'can_replace': True}, 'reply': {'state': 1, 'up_selection': True},
            'subtitle': {'allow': True, 'lan': 'zh-CN'}, 'arc_elec': {'state': 0}, 'origin_state': 0}
        self.metadata = {'recordedAt': '2026-10-04 20:38:02', 'window': {'start': 1163.8, 'end': 1193.9}}
        self.uploaded = {'filename': 'new-file', 'cid': 43}

    def test_replaces_only_media_and_generated_time_and_preserves_private_controls(self):
        original = copy.deepcopy(self.detail)
        payload = edit_payload(self.detail, self.uploaded, 'new-cover', self.metadata)
        self.assertEqual(payload['aid'], 123)
        self.assertEqual(payload['is_only_self'], 1)
        self.assertEqual(payload['title'], '人工改过的标题')
        self.assertEqual(payload['videos'], [{'filename': 'new-file', 'cid': 43, 'title': '原P标题', 'desc': '原P简介'}])
        self.assertEqual(payload['desc'], '人工简介\n切片时间：20:57:25 - 20:57:55（直播开始后第19分钟）')
        self.assertTrue(payload['up_close_reply']); self.assertTrue(payload['up_selection_reply'])
        self.assertEqual(payload['open_elec'], 1)
        self.assertEqual(payload['subtitles'], {'lan': 'zh-CN', 'open': 1})
        self.assertEqual(self.detail, original)

    def test_refuses_unsupported_switches_or_nonreplaceable_archives_before_upload(self):
        for change in ({'attribute': 8},):
            changed = copy.deepcopy(self.detail); changed['archive'].update(change)
            with self.assertRaisesRegex(ValueError, 'controls'):
                edit_payload(changed, self.uploaded, 'cover', self.metadata)
        self.detail['replace_check']['can_replace'] = False
        with self.assertRaisesRegex(ValueError, 'replaceable'):
            edit_payload(self.detail, self.uploaded, 'cover', self.metadata)

    def test_private_or_human_copy_changes_during_upload_abort_the_edit(self):
        for field, value in (('is_only_self', 0), ('title', 'new title')):
            current = copy.deepcopy(self.detail); current['archive'][field] = value
            with self.assertRaisesRegex(ValueError, 'changed'):
                unchanged_archive(self.detail, current)

    def test_cannot_reuse_old_media_filename(self):
        with self.assertRaisesRegex(ValueError, 'different'):
            edit_payload(self.detail, {'filename': 'old-file', 'cid': 42}, 'cover', self.metadata)

    def test_confirmation_updates_both_registry_and_authoritative_state_without_losing_original_receipt(self):
        clip = {'id': 7, 'uploadState': {'bvid': 'BVoriginal', 'cid': 42, 'mediaPath': 'old.mp4', 'submittedAt': 'original-time'},
                'automaticPublicationAuthorization': {'old': True}, 'reviewPending': True, 'reviewIssues': ['old identity changed']}
        state = {'done': {'1': copy.deepcopy(clip['uploadState']), '2': {'bvid': 'BVother', 'cid': 99}}}
        metadata = {'output': {'mediaPath': 'new.mp4', 'coverPath': 'new.jpg'}}
        result = {'bvid': 'BVoriginal', 'cid': 43, 'filename': 'new-file', 'status': 'confirmed', 'isOnlySelf': 1}
        updated, saved = record_replacement(clip, metadata, result, state, '用户要求修复', 'now')
        self.assertFalse(updated['reviewPending']); self.assertEqual(updated['reviewIssues'], [])
        self.assertNotIn('automaticPublicationAuthorization', updated)
        self.assertEqual(updated['mediaReplacement']['previousUploadState']['cid'], 42)
        self.assertEqual(updated['uploadState']['cid'], 43); self.assertEqual(saved['done']['1']['cid'], 43)
        self.assertEqual(saved['done']['1']['submittedAt'], 'original-time')
        self.assertEqual(saved['done']['2']['cid'], 99)
        self.assertEqual(clip['uploadState']['cid'], 42)


class ReplacementAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_uploads_file_and_edits_original_bv_without_starting_a_new_archive(self):
        from src.scripts.clip_media_replace import replace_existing
        fixture = MediaReplacementTests(); fixture.setUp()
        before = fixture.detail
        after = copy.deepcopy(before); after['videos'][0].update(fixture.uploaded)
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            metadata = {**fixture.metadata, 'output': {'mediaPath': 'rebuilt.mp4', 'coverPath': 'new.jpg'}}
            file = directory / 'clip.json'; file.write_text(json.dumps(metadata), encoding='utf-8')
            clip = {'metadataPath': str(file), 'uploadState': {'bvid': 'BVoriginal'}}
            instances, edits = [], []

            class Uploader:
                def __init__(self, *args, **kwargs):
                    self.line = None; instances.append(self)

                async def _upload_page(self, page):
                    if self.line != {'upcdn': 'fixture'}:
                        raise AssertionError('Upload line must be selected before uploading')
                    return fixture.uploaded

                async def start(self):
                    raise AssertionError('New archive submission is forbidden')

            class Editor:
                def __init__(self, bvid, meta, **kwargs):
                    self.meta = meta; edits.append((bvid, meta))

                async def _submit(self):
                    pass

            with (patch('bilibili_api.video_uploader.VideoUploader', Uploader),
                  patch('bilibili_api.video_uploader.VideoEditor', Editor),
                  patch('bilibili_api.video_uploader._choose_line', AsyncMock(return_value={'upcdn': 'fixture'})),
                  patch('bilibili_api.video_uploader.upload_cover', AsyncMock(return_value='https://archive.biliimg.com/new.jpg')),
                  patch('bilibili_api.utils.picture.Picture.from_file', return_value=object()),
                  patch('src.scripts.update_cover.load_auth', return_value=('cookie', None)),
                  patch('src.scripts.update_cover.fetch_archive', side_effect=[before, copy.deepcopy(before), after]),
                  patch('src.scripts.clip_auto_publication.validate_publication_review')):
                result = await replace_existing(clip, metadata, directory, 'auth.json')
            self.assertEqual(len(instances), 1); self.assertEqual(edits[0][0], 'BVoriginal')
            self.assertEqual(edits[0][1]['is_only_self'], 1)
            self.assertEqual(result['status'], 'confirmed')
            self.assertTrue((directory / 'SUBMITTED.json').is_file())
