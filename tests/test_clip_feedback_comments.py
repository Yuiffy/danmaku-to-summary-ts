import asyncio
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from contextlib import ExitStack, redirect_stdout

from src.scripts.clip_feedback_comments import prepare_comment, suggestion_from_subtitles
from src.scripts import clip_coordinate_comments as comments


class FeedbackCommentTests(unittest.TestCase):
    def test_coordinate_uses_rendered_time_and_multiline_cue(self):
        text = '21\n00:01:27,900 --> 00:01:30,000\n我又不是\n岁己啊\n\n'
        self.assertEqual(suggestion_from_subtitles(text, 1, '重点：我又不是岁己啊'),
            {'timestamp': '01:27', 'content': '重点：我又不是岁己啊', 'sourceCueId': 'C1'})
        for cue, content in [(21, '我又不是岁己啊'), (1, '凭空编造的回答'), (True, '我又不是岁己啊')]:
            with self.assertRaises(ValueError):
                suggestion_from_subtitles(text, cue, content)

    def test_feedback_authorizes_only_current_artifacts_and_sends_once_without_auto_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media, subtitles = root / 'clip.mp4', root / 'clip.srt'
            media.write_bytes(b'media')
            subtitles.write_text('1\n00:01:27,900 --> 00:01:30,000\n我又不是岁己啊\n', encoding='utf-8')
            record = {'mediaPath': str(media), 'srtPath': str(subtitles)}
            suggestion, approval = prepare_comment(record, {}, 1, '我又不是岁己啊', '评论区发坐标', 'now')
            clip = {**record, 'commentSuggestions': [suggestion], 'coordinateCommentApproval': approval}
            receipt = {'bvid': 'BVtest', 'aid': 123}
            with patch.object(comments.comment, 'send_comment', new_callable=AsyncMock, return_value={'rpid': 456}) as send:
                def publish(value=clip):
                    return asyncio.run(comments.publish_coordinate_comments(value, receipt, object(), {},
                        journal_directory=root / 'journal'))
                self.assertEqual(publish()['status'], 'published')
                self.assertEqual(publish()['status'], 'published')
                send.assert_awaited_once()
                self.assertEqual(send.call_args.kwargs['text'], '01:27 我又不是岁己啊')
                changed = copy.deepcopy(clip)
                changed['commentSuggestions'][0]['content'] = '另一条评论'
                self.assertEqual(publish(changed)['status'], 'blocked')
                subtitles.write_text('changed subtitles', encoding='utf-8')
                self.assertEqual(publish()['status'], 'blocked')
                subtitles.write_text('1\n00:01:27,900 --> 00:01:30,000\n我又不是岁己啊\n', encoding='utf-8')
                media.write_bytes(b'new edit')
                self.assertEqual(publish()['status'], 'blocked')
                self.assertEqual(send.await_count, 1)

    def test_cannot_choose_unrendered_or_pending_revision(self):
        for field in ['pendingCut', 'pendingRebuild', 'editorialExclusion']:
            with self.assertRaisesRegex(ValueError, 'Render'):
                prepare_comment({field: True}, {}, 1, '原话', '评论区坐标', 'now')

    def test_registry_command_prepares_then_explicitly_publishes_to_existing_bv_once(self):
        from src.scripts import clip_upload_registry as registry
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            for name, value in [('RUNTIME_DIR', root), ('REGISTRY_PATH', root / 'registry.json'), ('QUEUE_PATH', root / 'queue.json')]:
                stack.enter_context(patch.object(registry, name, value))
            media, subtitles, metadata = root / 'clip.mp4', root / 'clip.srt', root / 'clip.json'
            media.write_bytes(b'media')
            subtitles.write_text('1\n00:01:27,000 --> 00:01:30,000\n我又不是岁己啊\n', encoding='utf-8')
            metadata.write_text(json.dumps({'output': {'mediaPath': str(media), 'srtPath': str(subtitles)}}), encoding='utf-8')
            record = {'id': 4634, 'metadataPath': str(metadata), 'mediaPath': str(media), 'srtPath': str(subtitles)}
            registry.save_json(registry.REGISTRY_PATH, {'clips': {'4634': record}})
            registry.save_json(registry.QUEUE_PATH, {'jobs': []})
            args = registry.build_parser().parse_args(['coordinate-comment', '--id', '4634', '--cue', '1',
                '--content', '重点：我又不是岁己啊', '--note', '评论区发坐标', '--feedback-authorized'])
            with patch.object(comments.comment, 'send_comment') as send, redirect_stdout(io.StringIO()):
                self.assertEqual(args.func(args), 0)
                send.assert_not_called()
            saved = json.loads(metadata.read_text(encoding='utf-8'))
            registered = registry.load_json(registry.REGISTRY_PATH, {})['clips']['4634']
            self.assertEqual(registered['coordinateCommentApproval'], saved['coordinateCommentApproval'])
            self.assertEqual(registered['commentSuggestions'][0]['timestamp'], '01:27')
            registered['uploadState'] = {'bvid': 'BVtest', 'aid': 123, 'mediaPath': str(media)}
            registered['status'] = 'uploaded'
            registry.save_json(registry.REGISTRY_PATH, {'clips': {'4634': registered}})
            args.publish = True
            with patch('src.scripts.batch_upload.build_credential', return_value=object()), \
                    patch.object(comments.comment, 'send_comment', new_callable=AsyncMock, return_value={'rpid': 456}) as send, \
                    redirect_stdout(io.StringIO()):
                self.assertEqual(args.func(args), 0)
                self.assertEqual(args.func(args), 0)
                send.assert_awaited_once()
            published = registry.load_json(registry.REGISTRY_PATH, {})['clips']['4634']
            self.assertEqual(published['uploadState']['coordinateComments']['status'], 'published')
            self.assertEqual(registry.load_json(registry.QUEUE_PATH, {})['jobs'], [])

    def test_published_local_revisions_cannot_supply_online_coordinates(self):
        with self.assertRaisesRegex(ValueError, 'Published video differs'):
            prepare_comment({'mediaPath': 'new.mp4', 'srtPath': 'new.srt',
                'uploadState': {'bvid': 'BVtest', 'mediaPath': 'uploaded.mp4'}}, {}, 1, '原话', '发坐标', 'now')

    def test_abandoned_or_concurrent_publication_claim_never_sends_again(self):
        suggestion = {'timestamp': '01:29', 'content': '我又不是岁己啊'}
        clip = {'publicationKind': 'keyword_topic', 'automaticPublicationRequired': True, 'commentSuggestions': [suggestion]}
        with tempfile.TemporaryDirectory() as directory, patch.object(comments.comment, 'send_comment') as send:
            root = Path(directory)
            key = comments.suggestion_key('BVtest', suggestion)
            (root / f'{key}.claim').write_text('claimed before interruption', encoding='utf-8')
            result = asyncio.run(comments.publish_coordinate_comments(clip, {'bvid': 'BVtest', 'aid': 123}, object(),
                {'clipTopics': {'coordinateComments': {'mode': 'auto'}}}, journal_directory=root))
            self.assertEqual(result['items'][0]['state'], 'unknown')
            send.assert_not_called()
