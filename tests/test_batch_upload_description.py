import json
import tempfile
import unittest
from pathlib import Path

from src.scripts.batch_upload import (
    build_desc,
    load_generated_description,
    parse_upload_manifest,
    record_title_conflict,
    state_record_matches_upload,
    strip_review_score_suffix,
)


class BatchUploadDescriptionTests(unittest.TestCase):
    def test_review_score_suffix_is_not_part_of_media_path(self):
        self.assertEqual(
            strip_review_score_suffix(
                r"D:\clips\录制-25788785-20260828_fun_01.mp4 | 94分"
            ),
            r"D:\clips\录制-25788785-20260828_fun_01.mp4",
        )

    def test_uses_generated_description_and_adds_structured_fields_once(self):
        description = build_desc(
            '饼干小岁认不出来了？',
            '小轴 直播《困困夜行电台zzZ_merged》2026-07-27 22:03:54',
            '02:00:47',
            '00:00:39',
            (
                '直播切片\n'
                '直播切片\n'
                '线下见到熟人却认不出来，小轴疑惑：怎么变成饼干小岁了？\n\n'
                '来源：旧来源\n'
                '切片时间：00:00:00 - 00:00:39\n'
                '来源：旧来源'
            ),
        )

        self.assertEqual(
            description,
            (
                '线下见到熟人却认不出来，小轴疑惑：怎么变成饼干小岁了？\n\n'
                '来源：小轴 直播《困困夜行电台zzZ_merged》\n'
                '直播开始时间：2026-07-27 22:03:54\n\n'
                '切片时间：00:04:41 - 00:05:20（直播开始后第120分钟）'
            ),
        )
        self.assertEqual(description.count('来源：'), 1)
        self.assertEqual(description.count('直播切片'), 0)

    def test_without_generated_description_keeps_only_source_and_time(self):
        description = build_desc(
            '标题',
            '主播 直播《测试》2026-07-27 20:00:00',
            '00:01:00',
            '00:00:30',
        )

        self.assertEqual(
            description,
            (
                '来源：主播 直播《测试》\n'
                '直播开始时间：2026-07-27 20:00:00\n\n'
                '切片时间：20:01:00 - 20:01:30（直播开始后第1分钟）'
            ),
        )

    def test_falls_back_to_elapsed_clock_when_source_has_no_recorded_time(self):
        description = build_desc(
            '标题',
            '主播 直播《旧数据》2026-07-27',
            '01:02:03',
            '00:00:30',
        )

        self.assertIn(
            '切片时间：01:02:03 - 01:02:33（直播开始后第62分钟）',
            description,
        )

    def test_loads_generated_description_from_clip_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            media_path = Path(directory) / 'clip.mp4'
            metadata_path = media_path.with_suffix('.json')
            metadata_path.write_text(
                json.dumps({'copy': {'description': '提前生成的简介'}}, ensure_ascii=False),
                encoding='utf-8',
            )

            self.assertEqual(
                load_generated_description({'path': str(media_path)}),
                '提前生成的简介',
            )

    def test_json_manifest_keeps_metadata_path_separate_from_media_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            metadata_path = root / 'metadata.json'
            manifest_path = root / 'UPLOAD_MANIFEST.json'
            metadata_path.write_text(
                json.dumps(
                    {
                        'upload': {
                            'source': '主播 直播《测试》',
                            'prefix': '【小主播】',
                            'tags': ['主播', '#芙娅之魂'],
                            'roomId': '1820703922',
                        },
                        'window': {'start': 65.5, 'duration': 30.4},
                        'copy': {'title': 'JSON 标题', 'description': 'JSON 简介'},
                        'output': {
                            'mediaPath': str(root / 'actual.mp4'),
                            'metadataPath': str(metadata_path),
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding='utf-8',
            )
            manifest_path.write_text(
                json.dumps(
                    {'clips': [{'reviewIndex': 8, 'metadataPath': str(metadata_path)}]},
                    ensure_ascii=False,
                ),
                encoding='utf-8',
            )

            clips = parse_upload_manifest(manifest_path)
            clip = clips[0]
            self.assertEqual(clip['idx'], 8)
            self.assertEqual(clip['path'], str((root / 'actual.mp4').resolve()))
            self.assertEqual(clip['metadataPath'], str(metadata_path.resolve()))
            self.assertEqual(clip['tags'], ['主播', '#芙娅之魂'])
            self.assertEqual(clip['roomId'], '1820703922')
            self.assertEqual(
                load_generated_description(clip),
                'JSON 简介',
            )

    def test_title_only_duplicate_state_is_not_treated_as_local_upload(self):
        self.assertFalse(
            state_record_matches_upload(
                {
                    'source': 'search_dup',
                    'title': '【小岁】标题',
                    'bvid': 'BV1TITLEONLY',
                    'mediaPath': 'D:/clips/clip.mp4',
                },
                '【小岁】标题',
                'D:/clips/clip.mp4',
            )
        )

    def test_title_conflict_is_recorded_separately_from_done_state(self):
        state = {'done': {'3': {'source': 'search_dup', 'bvid': 'BV1OLD'}}}
        clip = {'idx': 3, 'path': 'D:/clips/correct.mp4'}

        record_title_conflict(
            state,
            clip,
            '【小岁】标题',
            bvid='BV1CONFLICT',
        )

        self.assertNotIn('3', state['done'])
        self.assertEqual(state['title_conflicts']['3']['source'], 'title_conflict')
        self.assertEqual(state['title_conflicts']['3']['bvid'], 'BV1CONFLICT')


if __name__ == '__main__':
    unittest.main()
