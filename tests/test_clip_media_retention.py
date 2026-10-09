"""Retention safety and offline replay; no real queues, FFmpeg or upload calls."""
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src' / 'scripts'))
import clip_media_retention as retention
import clip_media_restore as restore


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.root, self.archive = base / 'recordings', base / 'archive'
        self.date = self.root / '25788785_SUI' / '2026_09_01'
        self.derived = self.date / 'own_stream_fun_clips'
        self.derived.mkdir(parents=True)
        self.source = self.date / 'original.flv'
        self.source.write_bytes(b'original recording')
        self.media = self.derived / 'clip.mp4'
        self.media.write_bytes(b'published video')
        self.srt = self.media.with_suffix('.srt')
        self.srt.write_text('1\n00:00:00,000 --> 00:00:01,000\nreviewed words\n', encoding='utf-8')
        self.metadata_path = self.media.with_suffix('.json')
        self.metadata = {'mode': 'own_stream_fun_review', 'roomId': '25788785',
                         'source': {'mediaPath': str(self.source)}, 'window': {'start': 20.125, 'end': 23.75},
                         'output': {'mediaPath': str(self.media), 'srtPath': str(self.srt), 'burnedSubtitles': True}}
        self.save_metadata()
        self.now = dt.datetime(2026, 10, 7, tzinfo=dt.timezone.utc).timestamp()
        self.clip = {'id': 1, 'status': 'uploaded', 'mediaPath': str(self.media),
                     'metadataPath': str(self.metadata_path), 'uploadedAt': self.iso(self.now - 4 * retention.DAY),
                     'uploadState': {'source': 'ok', 'bvid': 'BV1234567890', 'mediaPath': str(self.media),
                                     'submittedAt': self.iso(self.now - 4 * retention.DAY), 'subtitleStatus': 'complete'}}
        self.registry = {'clips': {'1': self.clip}}
        self.queue = {'jobs': []}
        self.settings = {'ownStreamClips': {'subtitleVideoEncoder': 'h264_nvenc', 'subtitleFontName': 'Font'}}

    def iso(self, timestamp):
        return dt.datetime.fromtimestamp(timestamp, dt.timezone.utc).isoformat()

    def save_metadata(self):
        retention.atomic_json(self.metadata_path, self.metadata)

    def plan(self):
        return retention.plan_candidates(self.registry, self.queue, self.settings, self.root, self.archive, self.now)

    def apply(self, recipe, **kwargs):
        return retention.apply_recipe(recipe, self.registry, self.queue, now=self.now, **kwargs)

    def test_72_hour_boundary_and_definite_upload_only(self):
        for source, status, age, expected in [('ok', 'uploaded', 3 * retention.DAY, 1),
                                              ('ok', 'uploaded', 3 * retention.DAY - 1, 0),
                                              ('ok', 'uploaded', -1, 0), ('search_dup', 'uploaded', 9 * retention.DAY, 0),
                                              ('ok', 'uploading', 9 * retention.DAY, 0)]:
            with self.subTest(source=source, status=status, age=age):
                self.clip['status'] = status
                self.clip['uploadState']['source'] = source
                self.clip['uploadedAt'] = self.clip['uploadState']['submittedAt'] = self.iso(self.now - age)
                self.assertEqual(len(self.plan()[0]), expected)

    def test_active_job_and_shared_recent_submission_protect_media(self):
        self.queue['jobs'] = [{'status': 'pending', 'clipIds': [1]}]
        self.assertFalse(self.plan()[0])
        self.queue['jobs'] = []
        self.registry['clips']['2'] = {**self.clip, 'id': 2, 'uploadedAt': self.iso(self.now - 20)}
        self.assertFalse(self.plan()[0])
        self.registry['clips']['2']['status'] = 'pending_review'
        self.assertFalse(self.plan()[0])

    def test_unused_precision_selection_and_topic_plan_are_ordinary_media(self):
        self.metadata.update(precisionExperiment={'selected': False}, topicEditPlan={'ranges': []},
                             creativeResult={'status': 'kept_original'})
        self.save_metadata()
        self.assertEqual(len(self.plan()[0]), 1)
        self.metadata['editPlan'] = {'keep': [{'start': 1, 'end': 2}]}
        self.save_metadata()
        self.assertFalse(self.plan()[0])

    def test_recipe_precedes_deletion_and_metadata_survives(self):
        recipe = self.plan()[0][0]
        registry_before = json.dumps(self.registry)
        def remove(path):
            saved = retention.load_json(retention.receipt_path(recipe))
            self.assertEqual(saved['status'], 'prepared')
            self.assertEqual(saved['targets'][0]['srtContent'], self.srt.read_text(encoding='utf-8'))
            path.unlink()
        self.assertEqual(self.apply(recipe, remove=remove), len(b'published video'))
        self.assertFalse(self.media.exists())
        self.assertTrue(self.source.exists())
        self.assertTrue(self.metadata_path.exists())
        self.assertTrue(self.srt.exists())
        self.assertEqual(json.dumps(self.registry), registry_before)
        self.assertFalse(self.plan()[0])

    def test_changed_metadata_source_subtitles_and_new_reference_abort(self):
        for change in ('metadata', 'source', 'srt', 'queue', 'manual'):
            with self.subTest(change=change):
                recipe = self.plan()[0][0]
                if change == 'metadata':
                    self.metadata_path.write_text('{}', encoding='utf-8')
                elif change == 'source':
                    self.source.write_bytes(b'changed original')
                elif change == 'srt':
                    self.srt.write_text('changed subtitles', encoding='utf-8')
                elif change == 'queue':
                    self.queue['jobs'] = [{'status': 'running', 'clipIds': [1]}]
                with self.assertRaises(ValueError):
                    self.apply(recipe, extra=[str(self.media.resolve())] if change == 'manual' else [])
                self.assertTrue(self.media.exists())
                self.queue['jobs'] = []
                self.source.write_bytes(b'original recording')
                self.srt.write_text('1\n00:00:00,000 --> 00:00:01,000\nreviewed words\n', encoding='utf-8')
                self.save_metadata()

    def test_original_and_external_media_or_complex_edits_never_expire(self):
        for media, edit in [(self.source, False), (Path(self.temp.name) / 'outside.mp4', False), (self.media, True)]:
            with self.subTest(media=media, edit=edit):
                if not media.exists():
                    media.write_bytes(b'outside')
                self.metadata['output']['mediaPath'] = str(media)
                self.clip['mediaPath'] = self.clip['uploadState']['mediaPath'] = str(media)
                self.metadata['creativeResult'] = {'status': 'complete'} if edit else None
                self.save_metadata()
                self.assertFalse(self.plan()[0])
                self.assertTrue(media.exists())

    def test_interrupted_multipart_sweep_resumes_without_losing_recipe(self):
        second = self.derived / 'part2.mp4'
        second.write_bytes(b'second video')
        self.metadata.pop('mode')
        self.metadata['type'] = 'stream_game_submission'
        self.metadata['output']['parts'] = [{'start': 20, 'end': 23, 'mediaPath': str(self.media), 'srtPath': str(self.srt)},
                                             {'start': 23, 'end': 27, 'mediaPath': str(second), 'srtPath': str(self.srt)}]
        self.save_metadata()
        recipe = self.plan()[0][0]
        def interrupted(path):
            if path == second:
                raise OSError('interruption')
            path.unlink()
        with self.assertRaises(OSError):
            self.apply(recipe, remove=interrupted)
        self.assertFalse(self.media.exists())
        resumed = self.plan()[0][0]
        self.assertEqual(self.apply(resumed), len(b'second video'))
        self.assertFalse(second.exists())
        self.assertEqual(retention.load_json(retention.receipt_path(recipe))['status'], 'deleted')

    def test_unlink_before_progress_write_is_resumable(self):
        recipe = self.plan()[0][0]
        def crash(path):
            path.unlink()
            raise OSError('exit immediately after unlink')
        with self.assertRaises(OSError):
            self.apply(recipe, remove=crash)
        saved = retention.load_json(retention.receipt_path(recipe))
        self.assertEqual(saved['status'], 'prepared')
        self.assertEqual(saved['deleted'], [])
        self.assertEqual(self.apply(recipe), 0)
        self.assertEqual(retention.load_json(retention.receipt_path(recipe))['status'], 'deleted')

    def test_multipart_replay_uses_matching_existing_renderer(self):
        for kind, method in [('stream_game_submission', 'renderGamePart'), ('stream_activity_submission', 'renderActivityPart')]:
            with self.subTest(kind=kind):
                self.metadata.pop('mode', None)
                self.metadata['type'] = kind
                self.metadata['output']['parts'] = [{'start': 20.125, 'end': 23.75, 'mediaPath': str(self.media), 'srtPath': str(self.srt)}]
                self.save_metadata()
                recipe = self.plan()[0][0]
                calls = []
                def render(module, called_method, args):
                    calls.append((called_method, args))
                    Path(args[2]).write_bytes(b'rebuilt part')
                    return {'burnedSubtitles': False}
                restore.replay(recipe, Path(self.temp.name) / kind, render)
                self.assertEqual(calls[0][0], method)
                self.assertEqual(calls[0][1][1]['start'], 20.125)

    def test_game_multipart_requires_each_final_subtitle(self):
        self.metadata.pop('mode')
        self.metadata['type'] = 'stream_game_submission'
        self.metadata['output']['parts'] = [{'start': 20, 'end': 23, 'mediaPath': str(self.media)},
                                             {'start': 23, 'end': 27, 'mediaPath': str(self.media)}]
        self.save_metadata()
        self.assertFalse(self.plan()[0])

    def test_replay_uses_archived_original_exact_window_final_srt_without_upload(self):
        recipe = self.plan()[0][0]
        self.apply(recipe)
        archived = self.archive / self.source.relative_to(self.root)
        archived.parent.mkdir(parents=True)
        shutil.move(self.source, archived)
        archived_stat = archived.stat()
        os.utime(archived, ns=(archived_stat.st_atime_ns, archived_stat.st_mtime_ns // 1_000_000 * 1_000_000))
        calls = []
        def render(module, method, args):
            calls.append((module, method, args))
            Path(args[3]).write_bytes(b'rebuilt')
            self.assertEqual(Path(args[2]).read_text(encoding='utf-8'), recipe['targets'][0]['srtContent'])
            return {'burnedSubtitles': True}
        result = restore.replay(recipe, Path(self.temp.name) / 'replay', render)
        self.assertFalse(result['uploaded'])
        self.assertEqual(calls[0][1], 'cutClipMedia')
        self.assertEqual(calls[0][2][0]['mediaPath'], str(archived.resolve()))
        self.assertEqual(calls[0][2][1], {'start': 20.125, 'end': 23.75, 'duration': 3.625})
        self.assertEqual(calls[0][2][4]['subtitleVideoEncoder'], 'h264_nvenc')
        with self.assertRaises(FileExistsError):
            restore.replay(recipe, Path(self.temp.name) / 'replay', render)
        os.utime(archived, ns=(archived_stat.st_atime_ns, archived_stat.st_mtime_ns + 2_000_000))
        with self.assertRaises(ValueError):
            restore.replay(recipe, Path(self.temp.name) / 'changed-archive-replay', render)


if __name__ == '__main__':
    unittest.main()
