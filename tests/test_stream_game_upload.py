import asyncio
import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/scripts'))
import bilibili_upload_capabilities as capabilities
import game_subtitle_upload as subtitles
import stream_game_review as review
from batch_upload import save_upload_state
from clip_upload_manifest import load_upload_manifest
from clip_qa import validate_registry_qa


class GameUploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.flv'; self.source.write_bytes(b'original recording')
        self.source_srt = self.root / 'source.srt'; self.source_srt.write_text('source evidence', encoding='utf-8')
        self.cover = self.root / 'cover.jpg'; self.cover.write_bytes(b'cover')
        parts = []
        for index, (start, end) in enumerate([(5, 30), (30, 50)]):
            media = self.root / f'p{index}.mp4'; media.write_bytes(f'video-{index}'.encode())
            srt = self.root / f'p{index}.srt'; srt.write_text('1\n00:00:00,000 --> 00:00:02,000\n你好\n\n', encoding='utf-8')
            parts.append({'activityId': 'game-1', 'start': start, 'end': end, 'duration': end-start, 'actualDuration': end-start,
                'title': f'探索 {index+1}', 'burnedSubtitles': False, 'mediaPath': str(media), 'bytes': media.stat().st_size,
                'sha256': review.file_digest(media), 'srtPath': str(srt), 'srtSha256': review.file_digest(srt)})
        stat = self.source.stat()
        self.data = {'version': 1, 'type': 'stream_game_submission', 'kind': 'games', 'gameId': 'elden-ring',
            'sourceSnapshot': {'mediaPath': str(self.source), 'mediaBytes': str(stat.st_size), 'mediaMtimeNs': str(stat.st_mtime_ns),
                'srtPath': str(self.source_srt), 'srtSha256': review.file_digest(self.source_srt)}, 'planSignature': 'a',
            'coverage': {'status': 'complete', 'duration': 60, 'windows': [{'start': 0, 'end': 60, 'status': 'inspected'}]},
            'visualTimeline': {'status': 'complete', 'key': 'visual-source-identity', 'sampleSeconds': 30, 'samples': 3,
                'ranges': [{'first': 1, 'last': 3, 'kind': 'gameplay', 'gameId': 'elden-ring'}]},
            'activities': [{'id': 'game-1', 'start': 5, 'end': 50, 'excludedRanges': [], 'reviewIssues': [],
                'verification': {'decision': 'keep', 'publicCopySupported': True}}],
            'window': {'start': 5, 'end': 50, 'duration': 45}, 'copy': {'title': '游戏第1集', 'description': '本场游戏过程。'},
            'upload': {'prefix': '【小岁】', 'collectionSeasonId': 1, 'collectionSectionId': 2, 'externalSubtitles': True, 'subtitleLanguage': 'zh-CN'},
            'output': {'mediaPath': parts[0]['mediaPath'], 'coverPath': str(self.cover), 'parts': parts}, 'coverSha256': review.file_digest(self.cover)}
        self.metadata = self.root / 'game.json'; self.save()

    def tearDown(self): self.temp.cleanup()
    def save(self): self.metadata.write_text(json.dumps(self.data, ensure_ascii=False), encoding='utf-8')
    def approve(self):
        review.approve(self.metadata, '用户明确要求切并投稿', automatic=True)
        self.data = json.loads(self.metadata.read_text(encoding='utf-8'))

    def test_complete_video_subtitle_and_copy_binding(self):
        self.approve(); review.validate_game_review(self.data)
        clips = load_upload_manifest(self.metadata)
        self.assertEqual(len(clips), 1)
        self.assertTrue(clips[0]['gameReviewRequired']); self.assertFalse(clips[0]['activityReviewRequired'])
        self.assertTrue(clips[0]['externalSubtitles'])
        Path(self.data['output']['parts'][1]['srtPath']).write_text('changed subtitle', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'subtitles changed'): review.validate_game_review(self.data)

    def test_game_gaps_duplicates_and_incomplete_source_are_rejected(self):
        for mutate in [lambda x: x['output']['parts'][1].update(start=31, duration=19, actualDuration=19),
                       lambda x: x['output']['parts'].reverse(),
                       lambda x: x['coverage']['windows'][0].update(end=59)]:
            x = copy.deepcopy(self.data); mutate(x)
            with self.assertRaises(ValueError): review.check_artifacts(x)

    def test_queue_cannot_remove_game_review_or_external_subtitle_delivery(self):
        self.approve()
        clip = load_upload_manifest(self.metadata)[0]
        self.assertEqual(validate_registry_qa([[clip]]), [])
        for key, value in [('gameReviewRequired', False), ('externalSubtitles', False), ('subtitleLanguage', 'en-US'), ('metadataPath', None)]:
            changed = copy.deepcopy(clip); changed[key] = value
            self.assertTrue(validate_registry_qa([[changed]]), key)

    def test_v2_media_review_cannot_approve_chat_or_replayed_game_frames(self):
        verdict = self.data['activities'][0]['verification']
        verdict.update(version=2, start=5, end=50, frameTimes=[8, 48],
                       audioObservations=[{'index': 1, 'heardWords': '以前玩过'}, {'index': 2, 'heardWords': '今天先聊聊'}],
                       frameObservations=[{'index': 1, 'activity': 'other', 'description': 'talking avatar'},
                                          {'index': 2, 'activity': 'watching_game', 'description': 'game replay in browser'}])
        with self.assertRaisesRegex(ValueError, 'no visible live gameplay'): review.check_artifacts(self.data)
        verdict['frameObservations'][0].update(activity='gameplay', description='live character and HUD')
        review.check_artifacts(self.data)
        verdict['frameTimes'][0] = 4
        with self.assertRaisesRegex(ValueError, 'no visible live gameplay'): review.check_artifacts(self.data)
        verdict['frameTimes'][0] = 8
        verdict['version'] = 3
        with self.assertRaisesRegex(ValueError, 'independent original'): review.check_artifacts(self.data)
        verdict['boundaryReview'] = {'version': 1, 'decision': 'keep', 'timeBasis': 'audio_local_seconds',
                                    'startObserved': True, 'endObserved': True, 'start': 5, 'end': 50,
                                    'audioObservations': verdict['audioObservations']}
        review.check_artifacts(self.data)
        verdict['boundaryReview']['end'] = 51
        with self.assertRaisesRegex(ValueError, 'differ from the accepted'): review.check_artifacts(self.data)

    def test_current_account_permissions_override_multipart_assumptions(self):
        class Response:
            def __init__(self, payload): self.payload = payload
            def raise_for_status(self): pass
            def json(self): return self.payload
        replies = iter([Response({'code': 0, 'data': {'have_permission_of_p': False, 'season': True}}),
                        Response({'code': 0, 'data': {'myinfo': {'mid': 42, 'subtitle': True, 'uploadsize': {'8-16': True}, 'uploadduration': {'3-10': False}}}})])
        result = capabilities.fetch_capabilities('secret-never-printed', get=lambda *a, **k: next(replies))
        self.assertEqual(result['maxParts'], 1)
        self.assertEqual(result['maxFileBytes'], 16*1024**3)
        self.assertEqual(result['maxVideoSeconds'], 10800)

    def test_protocol8_boundary_quotes_must_match_source_and_accepted_times(self):
        self.source_srt.write_text('1\n00:00:05,000 --> 00:00:07,000\n我要打开游戏了\n\n'
                                   '2\n00:00:48,000 --> 00:00:50,000\n今天游戏先玩到这里\n', encoding='utf-8')
        audio = [{'index': 1, 'heardWords': '我要打开游戏了'}, {'index': 2, 'heardWords': '今天游戏先玩到这里'}]
        verdict = self.data['activities'][0]['verification']
        verdict.update(version=3, protocolVersion=8, start=5, end=50, audioObservations=audio,
                       audioWindows=[{'start': 0, 'end': 10}, {'start': 45, 'end': 60}], frameTimes=[8, 48],
                       frameObservations=[{'index': i + 1, 'activity': 'gameplay', 'description': 'live game HUD'} for i in range(2)],
                       boundaryReview={'version': 1, 'decision': 'keep', 'timeBasis': 'audio_local_seconds',
                                       'startObserved': True, 'endObserved': True, 'start': 5, 'end': 50, 'audioObservations': audio,
                                       'excerptReviews': [
                                           {'decision': 'keep', 'observed': True, 'boundaryAnchor': 'before_phrase',
                                            'heardWords': audio[0]['heardWords'], 'timingSource': 'original_transcript_quote',
                                            'quoteSource': {'start': 5, 'end': 7}, 'seconds': 5},
                                           {'decision': 'keep', 'observed': True, 'boundaryAnchor': 'after_phrase',
                                            'heardWords': audio[1]['heardWords'], 'timingSource': 'original_transcript_quote',
                                            'quoteSource': {'start': 48, 'end': 50}, 'seconds': 5}]})
        review.check_artifacts(self.data)
        for mutate, message in [
            (lambda v: v['boundaryReview']['excerptReviews'].pop(), 'quote evidence is incomplete'),
            (lambda v: v['boundaryReview']['excerptReviews'][1]['quoteSource'].update(end=51), 'timestamp differs from source'),
            (lambda v: v['audioWindows'][1].update(start=49), 'timestamp differs from source'),
            (lambda v: v['boundaryReview']['excerptReviews'][1].update(seconds=6), 'differs from its original quote')]:
            data = copy.deepcopy(self.data); mutate(data['activities'][0]['verification'])
            with self.assertRaisesRegex(ValueError, message): review.check_artifacts(data)
        self.source_srt.write_text('1\n00:00:05,000 --> 00:00:07,000\n我要打开游戏了\n\n'
                                   '2\n00:00:08,000 --> 00:00:09,000\n我要打开游戏了\n\n'
                                   '3\n00:00:48,000 --> 00:00:50,000\n今天游戏先玩到这里\n', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'absent or ambiguous'): review.check_artifacts(self.data)

    def test_protocol9_preserves_silent_exit_and_binds_original_frames(self):
        samples, frames = [], []
        for i, time in enumerate([50, 52, 52.25, 52.5, 52.75, 53, 54, 56]):
            image = self.root / f'closing-{i}.jpg'; image.write_bytes(f'original frame {time}'.encode())
            samples.append({'index': i + 1, 'time': time, 'path': str(image), 'sha256': review.file_digest(image)})
            frames.append({'index': i + 1, 'activity': 'game' if time < 53 else 'other', 'description': 'Actual original scene'})
        verdict = {'end': 53, 'boundaryReview': {'spokenEnd': 50}, 'endFrameReview': {'version': 1,
                   'spokenEnd': 50, 'scanEnd': 56, 'sampleSeconds': 2, 'resolutionSeconds': .25, 'end': 53,
                   'reason': 'Exit menu and fade finish after the closing sentence', 'samples': samples, 'frames': frames}}
        self.assertEqual(review.check_closing_frames(verdict, 60), 50)
        for mutate, message in [
            (lambda v: v.update(end=50), 'ending differs'),
            (lambda v: v['endFrameReview']['frames'][1].update(activity='uncertain'), 'remain uncertain'),
            (lambda v: v['endFrameReview']['samples'][0].update(sha256='changed'), 'evidence changed'),
            (lambda v: v['endFrameReview']['frames'][-1].update(activity='game'), 'remains visible')]:
            changed = copy.deepcopy(verdict); mutate(changed)
            with self.assertRaisesRegex(ValueError, message): review.check_closing_frames(changed, 60)

    def test_protocol10_independent_asr_rechecks_original_audio_frames_and_both_quote_clocks(self):
        self.source_srt.write_text('1\n00:00:05,000 --> 00:00:07,000\n我要打开游戏了\n\n'
                                   '2\n00:00:48,000 --> 00:00:50,000\n今天游戏先玩到这里\n', encoding='utf-8')
        identity = {k: self.data['sourceSnapshot'][k] for k in ('mediaPath', 'mediaBytes', 'mediaMtimeNs')}
        def extraction(file, start, end=None):
            file.write_bytes(b'actual original evidence')
            args = ['-y', '-ss', str(start), '-i', str(self.source)]
            args += (['-t', str(end-start), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k']
                     if end is not None else ['-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '3'])
            args += [str(file)]
            receipt = {'version': 3, 'source': identity, 'args': args, 'sha256': review.file_digest(file)}
            receipt['signature'] = hashlib.sha256(json.dumps({'args': args, 'source': identity},
                ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
            p = Path(str(file)+'.complete.json'); p.write_text(json.dumps(receipt), encoding='utf-8')
            return p, receipt
        audio, excerpts = [], []
        windows = [{'start': 0, 'end': 10}, {'start': 45, 'end': 60}]
        for i, (window, quote_start, quote_end, words) in enumerate(zip(windows, [5, 48], [7, 50], ['我要打开游戏了', '今天游戏先玩到这里'])):
            file = self.root/f'audio-{i+1}.mp3'; receipt_path, receipt = extraction(file, window['start'], window['end'])
            asr_path = self.root/f'asr-{i}.json'
            asr_path.write_text(json.dumps({'segments': [{'start': quote_start-window['start'], 'end': quote_end-window['start'], 'text': words}]}), encoding='utf-8')
            provenance = self.root/f'audio-{i}-source.json'
            bundle = {'version': 1, 'method': 'independent_local_asr', 'backend': 'paraformer', 'source': identity,
                      'start': window['start'], 'end': window['end'], 'audioPath': str(file), 'audioSha256': receipt['sha256'],
                      'receiptPath': str(receipt_path), 'receiptSha256': review.file_digest(receipt_path), 'settingsSignature': 'decoder-settings',
                      'asrPath': str(asr_path), 'asrSha256': review.file_digest(asr_path)}
            provenance.write_text(json.dumps(bundle), encoding='utf-8')
            bundle.update(provenancePath=str(provenance), provenanceSha256=review.file_digest(provenance))
            audio.append({'index': i+1, 'heardWords': words})
            excerpts.append({'decision': 'keep', 'observed': True, 'boundaryAnchor': 'before_phrase' if i == 0 else 'after_phrase',
                'heardWords': words, 'timingSource': 'original_transcript_quote', 'quoteSource': {'start': quote_start, 'end': quote_end},
                'seconds': (quote_start if i == 0 else quote_end)-window['start'],
                'localAudioEvidence': {'version': 1, 'method': 'independent_local_asr', 'primary': bundle, 'retranscriptions': []},
                'independentlyTranscribedQuote': {'contextIndex': 0, 'quoteSource': {'start': quote_start, 'end': quote_end}}})
        frames = []
        for i, time in enumerate([8, 48]):
            file = self.root/f'frame-{i+1}.jpg'; extraction(file, time)
            frames.append({'index': i+1, 'time': time, 'path': str(file), 'sha256': review.file_digest(file)})
        closing = []
        for i, time in enumerate([50, 52, 54, 56]):
            file = self.root/f'closing-{i}.jpg'; extraction(file, time)
            closing.append({'index': i+1, 'time': time, 'path': str(file), 'sha256': review.file_digest(file)})
        verdict = self.data['activities'][0]['verification']
        verdict.update(version=4, protocolVersion=10, evidenceMethod='independent_local_asr', evidenceDirectory=str(self.root),
            start=5, end=50, audioObservations=audio, audioWindows=windows, frameTimes=[8, 48], originalFrameEvidence=frames,
            frameObservations=[{'index': i+1, 'activity': 'gameplay', 'description': 'Live host and original HUD'} for i in range(2)],
            boundaryReview={'version': 1, 'decision': 'keep', 'timeBasis': 'audio_local_seconds', 'startObserved': True, 'endObserved': True,
                            'start': 5, 'end': 50, 'spokenEnd': 50, 'audioObservations': audio, 'excerptReviews': excerpts},
            endFrameReview={'version': 1, 'spokenEnd': 50, 'scanEnd': 56, 'sampleSeconds': 2, 'resolutionSeconds': .25, 'end': 50,
                            'reason': 'Closing shows an unobstructed talking scene', 'samples': closing,
                             'frames': [{'index': i+1, 'activity': 'other', 'description': 'Unobstructed talking scene'} for i in range(4)]})
        review.check_artifacts(self.data)
        proposal = self.root/'copy-proposal.json'
        new_copy = {'title': '原场景探索', 'description': '查看原游戏场景。'}
        proposal.write_text(json.dumps({'text': json.dumps({**new_copy, 'reason': 'Original frames support this brief scene description'})}), encoding='utf-8')
        editorial_data = copy.deepcopy(self.data)
        editorial_data['activities'][0]['chapters'] = [{'start': 5, **new_copy, 'editorialRevision': {'version': 1,
            'source': self.data['sourceSnapshot'], 'originalCopy': {'title': '未经证实的胜利', 'description': '击败敌人。'},
            'newCopy': new_copy, 'rejectionReason': 'No visible victory', 'phaseStart': 5, 'phaseEnd': 50,
            'frames': frames, 'proposalPath': str(proposal), 'proposalSha256': review.file_digest(proposal)}}]
        review.check_artifacts(editorial_data)
        altered_copy = copy.deepcopy(editorial_data)
        altered_copy['activities'][0]['chapters'][0]['title'] = 'edited after proposal'
        with self.assertRaisesRegex(ValueError, 'editorial copy differs'): review.check_artifacts(altered_copy)
        split = copy.deepcopy(editorial_data)
        split['output']['parts'] = split['output']['parts'][:1]
        split['activities'][0].update(end=30, sourceWindow={'start': 5, 'end': 50})
        split['window'].update(end=30, duration=25)
        # Full-session chapter evidence can follow this submission's shorter P.
        review.check_artifacts(split)
        split['activities'][0]['sourceWindow']['end'] = 51
        with self.assertRaisesRegex(ValueError, 'source window differs'): review.check_artifacts(split)
        for mutate, message in [
            (lambda v: v.update(version=3), 'diagnostic game audio'),
            (lambda v: v.update(evidenceMethod='local_asr_diagnostic'), 'original-evidence protocol'),
            (lambda v: v['boundaryReview']['excerptReviews'][0].pop('localAudioEvidence'), 'missing its actual'),
            (lambda v: v['boundaryReview']['excerptReviews'][1]['independentlyTranscribedQuote']['quoteSource'].update(end=51), 'differs from original evidence'),
            (lambda v: v['originalFrameEvidence'][0].update(time=9), 'original frame evidence changed')]:
            changed = copy.deepcopy(self.data); mutate(changed['activities'][0]['verification'])
            with self.assertRaisesRegex(ValueError, message): review.check_artifacts(changed)
        Path(excerpts[0]['localAudioEvidence']['primary']['audioPath']).write_bytes(b'changed original sound')
        with self.assertRaisesRegex(ValueError, 'differs from original recording'): review.check_artifacts(self.data)

    def test_subtitles_wait_for_cids_then_submit_once_per_correct_page(self):
        self.approve()
        task = subtitles.register_task({'metadataPath': str(self.metadata), 'externalSubtitles': True}, {'bvid': 'BV1234567890'}, self.root/'tasks')
        result = asyncio.run(subtitles.process_task(task, None, '', fetch_pages=lambda *a: []))
        self.assertEqual(result['subtitleStatus'], 'pending_archive')
        sent = []
        async def submit(language, payload, cid): sent.append((language, cid, payload['body'][0]['from'])); return {'subtitle_id': cid}
        online = [{'title': p['title'], 'cid': i+100} for i, p in enumerate(self.data['output']['parts'])]
        result = asyncio.run(subtitles.process_task(task, None, '', fetch_pages=lambda *a: online, submit=submit))
        self.assertEqual(result['subtitleStatus'], 'complete')
        asyncio.run(subtitles.process_task(task, None, '', fetch_pages=lambda *a: online, submit=submit))
        self.assertEqual(sent, [('zh', 100, 0.0), ('zh', 101, 0.0)])

    def test_reordered_online_pages_and_uncertain_writes_cannot_send_wrong_subtitles(self):
        parts = self.data['output']['parts']
        with self.assertRaisesRegex(ValueError, 'order/title'): subtitles.bind_pages(parts, [{'title': p['title'], 'cid': i+1} for i,p in enumerate(reversed(parts))])
        self.approve()
        task = subtitles.register_task({'metadataPath': str(self.metadata), 'externalSubtitles': True}, {'bvid': 'BV1234567890'}, self.root/'tasks')
        sent = []
        async def submit(*args): sent.append(args); raise TimeoutError('reply was lost after the POST')
        online = [{'title': p['title'], 'cid': i+1} for i,p in enumerate(parts)]
        self.assertEqual(asyncio.run(subtitles.process_task(task, None, '', fetch_pages=lambda *a: online, submit=submit))['subtitleStatus'], 'uncertain')
        self.assertEqual(asyncio.run(subtitles.process_task(task, None, '', fetch_pages=lambda *a: online, submit=submit))['subtitleStatus'], 'uncertain')
        self.assertEqual(len(sent), 1)

    def test_only_confirmed_language_rejections_can_change_to_current_platform_code(self):
        self.approve()
        task = subtitles.register_task({'metadataPath': str(self.metadata), 'externalSubtitles': True}, {'bvid': 'BV1234567890'}, self.root/'tasks')
        payload = subtitles.subtitle_payload(self.data['output']['parts'][0]['srtPath'], 25)
        state = json.loads(task.read_text(encoding='utf-8'))
        state['pages']['1'] = {'cid': 100, 'language': 'zh-CN', 'payloadSha256': subtitles.payload_digest(payload),
            'status': 'rejected', 'errorCode': 79011, 'error': 'invalid language'}
        task.write_text(json.dumps(state), encoding='utf-8')
        online = [{'title': p['title'], 'cid': i+100} for i,p in enumerate(self.data['output']['parts'])]
        sent = []
        async def submit(language, payload, cid): sent.append((language, cid)); return {'subtitle_id': cid}
        result = asyncio.run(subtitles.process_task(task, None, '', fetch_pages=lambda *a: online, submit=submit))
        self.assertEqual(result['subtitleStatus'], 'complete')
        self.assertEqual(sent, [('zh', 100), ('zh', 101)])
        restored = json.loads(task.read_text(encoding='utf-8'))
        self.assertTrue(restored['pages']['1']['rejectedAttempts'][0]['confirmedRejection'])

    def test_subtitles_recover_when_a_new_archive_is_not_yet_visible(self):
        self.approve()
        task = subtitles.register_task({'metadataPath': str(self.metadata), 'externalSubtitles': True}, {'bvid': 'BV1234567890'}, self.root/'tasks')
        online = [{'title': p['title'], 'cid': i+100} for i,p in enumerate(self.data['output']['parts'])]
        class ArchiveNotVisible(Exception): code = 79022
        sent = []
        async def reject(language, payload, cid): sent.append((language, cid)); raise ArchiveNotVisible('archive is still processing')
        result = asyncio.run(subtitles.process_task(task, None, '', fetch_pages=lambda *a: online, submit=reject))
        self.assertEqual(result['subtitleStatus'], 'pending_archive')
        state = json.loads(task.read_text(encoding='utf-8'))
        self.assertEqual(state['status'], 'retry_wait')
        self.assertEqual(state['pages']['1']['status'], 'rejected')
        async def submit(language, payload, cid): sent.append((language, cid)); return {'subtitle_id': cid}
        result = asyncio.run(subtitles.process_task(task, None, '', fetch_pages=lambda *a: online, submit=submit))
        self.assertEqual(result['subtitleStatus'], 'complete')
        self.assertEqual(sent, [('zh', 100), ('zh', 100), ('zh', 101)])
        asyncio.run(subtitles.process_task(task, None, '', fetch_pages=lambda *a: online, submit=submit))
        self.assertEqual(len(sent), 3)

    def test_another_video_finishing_does_not_erase_completed_subtitles(self):
        path = self.root / 'upload_state.json'
        previous = {'done': {'1': {'bvid': 'BV1234567890', 'subtitleStatus': 'complete', 'subtitlePages': [{'cid': 100}]}}}
        path.write_text(json.dumps(previous), encoding='utf-8')
        stale = {'done': {'1': {'bvid': 'BV1234567890', 'subtitleStatus': 'pending_archive'}, '2': {'bvid': 'BV0987654321'}}}
        with patch('clip_upload_registry.acquire_queue_mutation_lock'), patch('clip_upload_registry.release_queue_mutation_lock'):
            save_upload_state(path, stale)
            self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['done']['1']['subtitleStatus'], 'complete')
            stale['done']['1'] = {'bvid': 'BVdifferent0'}
            save_upload_state(path, stale)
            self.assertNotIn('subtitleStatus', json.loads(path.read_text(encoding='utf-8'))['done']['1'])

    def test_uncertain_post_is_confirmed_read_only_without_a_second_write(self):
        self.approve()
        task = subtitles.register_task({'metadataPath': str(self.metadata), 'externalSubtitles': True}, {'bvid': 'BV1234567890'}, self.root/'tasks')
        sent = []
        async def submit(*args): sent.append(args); raise TimeoutError('lost response')
        online = [{'title': p['title'], 'cid': i+1} for i,p in enumerate(self.data['output']['parts'])]
        asyncio.run(subtitles.process_task(task, None, '', fetch_pages=lambda *a: online, submit=submit))
        async def confirm(language, cid, digest): return {'subtitle_id': 123, 'confirmedBy': 'matching_online_payload'}
        async def finish(language, payload, cid): sent.append((language, payload, cid)); return {'subtitle_id': 124}
        result = asyncio.run(subtitles.process_task(task, None, '', fetch_pages=lambda *a: online, submit=finish, confirm=confirm))
        self.assertEqual(result['subtitleStatus'], 'complete')
        self.assertEqual(len(sent), 2)  # one lost first-page response and the second page


if __name__ == '__main__': unittest.main()
