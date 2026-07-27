import json
import tempfile
import unittest
from pathlib import Path

from src.scripts.batch_upload import build_desc, load_generated_description


class BatchUploadDescriptionTests(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
