"""Regression tests for the editorial clip-cover generator."""

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "scripts"))

from cover_generator import CoverGenerator  # noqa: E402


class CoverGeneratorTests(unittest.TestCase):
    def test_extract_frame_uses_fast_input_seek(self):
        generator = CoverGenerator()
        with (
            patch("cover_generator.os.path.exists", return_value=True),
            patch("cover_generator.subprocess.run") as run,
        ):
            generator.extract_frame("input.mp4", 116.95, "output.jpg")

        command = run.call_args.args[0]
        self.assertEqual(command[:5], ["ffmpeg", "-ss", "116.95", "-i", "input.mp4"])

    def test_preserves_explicit_two_line_cover_copy(self):
        self.assertEqual(
            CoverGenerator.build_cover_lines("你们不宠我了\\n只会找我问题！"),
            ("你们不宠我了", "只会找我问题！"),
        )

    def test_preserves_quotes_instead_of_stripping_line_ends(self):
        samples = [
            ("窗外出现“宿敌”", "随后宣布“拯救成功”"),
            ('他说"等等"', '回答"真的？"'),
            ("她说‘等等’", "回答「真的？」"),
            ("“完整原话”", "『保留两端』"),
            ("“一句话跨过", "两行也要完整”"),
            ("他说“她回答‘好’”", "【这也是文案】"),
        ]
        for lines in samples:
            for separator in ("\n", "\\n", "\r\n"):
                with self.subTest(lines=lines, separator=separator):
                    self.assertEqual(CoverGenerator.build_cover_lines(separator.join(lines)), lines)

    def test_explicit_long_copy_is_not_shortened_or_silently_dropped(self):
        lines = ("原本只是想给这个电脑换显卡", "结果最后却要把整台电脑全部换掉")
        self.assertEqual(CoverGenerator.build_cover_lines("\n".join(lines)), lines)
        self.assertEqual(
            CoverGenerator.build_cover_lines("第一段\n第二段\n第三段”"),
            ("第一段", "第二段\n第三段”"),
        )

    def test_fallback_does_not_split_inside_a_quote_or_leave_a_prefix_fragment(self):
        self.assertEqual(
            CoverGenerator.build_cover_lines("【小岁】窗外出现“宿敌”：随后宣布“拯救成功”"),
            ("窗外出现“宿敌”", "随后宣布“拯救成功”"),
        )
        for title in ("她说“等等，真的？”", '她说"听好：现在开始！"', "不拆开短标题"):
            with self.subTest(title=title):
                self.assertEqual(CoverGenerator.build_cover_lines(title), ("", title))

    def test_fallback_uses_setup_before_a_standalone_speaker_label(self):
        samples = [
            ("想找旅行搭子又怕吵架？小岁：我必须要跟别人一起玩才好玩",
             ("想找旅行搭子又怕吵架", "我必须要跟别人一起玩才好玩")),
            ("新游戏攻击方式很单一？小岁：我还挺喜欢攻击方式单一的游戏",
             ("新游戏攻击方式很单一", "我还挺喜欢攻击方式单一的游戏")),
            ("弹幕脑补同事暧昧？小岁：这只是正常的同事间的交往",
             ("弹幕脑补同事暧昧", "这只是正常的同事间的交往")),
            ("想找旅行搭子又怕吵架：岁己SUI：“一起玩才好玩”",
             ("想找旅行搭子又怕吵架", "“一起玩才好玩”")),
        ]
        generator = CoverGenerator()
        for title, expected in samples:
            with self.subTest(title=title):
                self.assertEqual(generator.build_cover_lines(title), expected)
                if all(generator.font_paths.values()):
                    rows = generator._layout_text(ImageDraw.Draw(Image.new("RGB", (1920, 1080))), title, 1920, 1080)
                    self.assertEqual({row["role"] for row in rows}, {"kicker", "headline"})
                    self.assertEqual("".join(row["text"] for row in rows), "".join(expected))

    def test_wrap_avoids_orphan_punctuation_and_splitting_short_latin_tokens(self):
        for text in ("大家说“现在出发”", '大家说"现在出发"', "更新GPT-6模型", "电量只剩22%了", "先试，再试！"):
            with self.subTest(text=text):
                lines = CoverGenerator._wrap_text(text, len, 7)
                self.assertIsNotNone(lines)
                self.assertEqual("".join(lines), text)
                for line in lines:
                    self.assertLessEqual(len(line), 7)
                    self.assertNotIn(line[0], "”’」，。！？；：、,.!?;:%")
                    self.assertNotIn(line[-1], "“‘「")
                for token in ('GPT-6', '22%', '"现在出发"'):
                    if token in text:
                        self.assertTrue(any(token in line for line in lines))

    def test_wrap_prefers_known_chinese_word_boundaries(self):
        title = "竟然只是为了有力气直播跳舞给大家看"
        words = ("竟然", "只是", "为了", "有", "力气", "直播", "跳舞", "给", "大家", "看")
        spans, start = [], 0
        for word in words:
            spans.append((word, start, start + len(word)))
            start += len(word)
        with patch.object(CoverGenerator, "_word_spans", return_value=spans):
            lines = CoverGenerator._wrap_text(title, len, 10)
        self.assertEqual("".join(lines), title)
        self.assertEqual(len(lines), 2)
        for word in words:
            self.assertTrue(any(word in line for line in lines), word)

    def test_wrap_without_optional_segmenter_still_preserves_copy_and_quotes(self):
        title = "竟然只是为了有力气直播跳舞给大家看"
        with patch.object(CoverGenerator, "_word_spans", return_value=()):
            lines = CoverGenerator._wrap_text(title, len, 10)
            self.assertEqual("".join(lines), title)
            self.assertEqual(CoverGenerator._wrap_text('大家说"现在出发"', len, 7), ['大家说', '"现在出发"'])

    @unittest.skipUnless(shutil.which("node"), "Node is required for the JS-to-Python argument regression")
    def test_node_spawn_preserves_title_quotes_and_newline_arguments(self):
        python_source = (
            "import json,sys;sys.path.insert(0,sys.argv[1]);"
            "from cover_generator import CoverGenerator;"
            "print(json.dumps([sys.argv[2],CoverGenerator.build_cover_lines(sys.argv[2])]))"
        )
        node_source = (
            'const {spawnSync}=require("node:child_process");'
            'const child=spawnSync(process.argv[1],["-c",...process.argv.slice(2)],'
            '{shell:false,windowsHide:true,encoding:"utf8"});'
            'process.stdout.write(child.stdout||"");process.stderr.write(child.stderr||"");'
            'process.exit(child.status??1);'
        )
        for title in ('窗外出现“宿敌”\n随后宣布“拯救成功”', 'He said "yes"\\nIt\'s "22%"'):
            with self.subTest(title=title):
                result = subprocess.run(
                    [shutil.which("node"), "-e", node_source, sys.executable, python_source,
                     str(ROOT / "src" / "scripts"), title],
                    check=True, capture_output=True, text=True, encoding="utf-8", timeout=20,
                )
                original, lines = json.loads(result.stdout)
                self.assertEqual(original, title)
                self.assertEqual(lines, title.replace("\\n", "\n").splitlines())

    def test_derives_a_readable_fallback_from_a_long_upload_title(self):
        kicker, headline = CoverGenerator.build_cover_lines(
            "提建议被当成找茬？岁己委屈控诉：你们不宠我了，只会从我身上找问题！"
        )
        self.assertEqual(kicker, "你们不宠我了")
        self.assertIn("找问题", headline)
        self.assertLessEqual(len(kicker), 11)
        self.assertLessEqual(len(headline), 12)

    def test_renders_a_1920_by_1080_jpeg(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "frame.png"
            output = Path(directory) / "cover.jpg"
            Image.new("RGB", (1280, 720), (93, 75, 140)).save(source)

            generator = CoverGenerator()
            untouched_pixel = generator._prepare_canvas(str(source)).getpixel((1000, 700))
            generator.add_text_to_cover(
                str(source), "充一小时只剩22%\\n蓝头寿终正寝", subtitle="小岁", output_path=str(output)
            )

            self.assertTrue(output.exists())
            with Image.open(output) as rendered:
                self.assertEqual(rendered.size, (1920, 1080))
                # The previous design darkened this whole area with a translucent
                # panel.  JPEG encoding may shift a channel slightly, but the
                # frame should now remain visually untouched away from the text.
                actual = rendered.getpixel((1000, 700))
                self.assertTrue(all(abs(a - b) <= 4 for a, b in zip(actual, untouched_pixel)))

    def test_text_layout_stays_inside_centered_four_by_three_crop(self):
        generator = CoverGenerator()
        layout = generator._text_layout(1920, 1080)

        self.assertEqual(layout["safe_left"], 240)
        self.assertEqual(layout["safe_right"], 1680)
        self.assertGreater(layout["kicker_x"], layout["safe_left"])
        self.assertGreater(layout["headline_x"], layout["safe_left"])
        self.assertLessEqual(
            layout["headline_x"] + layout["max_width"],
            layout["safe_right"],
        )

    def test_long_copy_wraps_completely_with_nonoverlapping_ink_inside_safe_crop(self):
        generator = CoverGenerator()
        if not all(generator.font_paths.values()):
            self.skipTest("A local Chinese TrueType font is required for pixel layout checks")
        samples = [
            "窗外出现“宿敌”\n随后宣布“拯救成功”",
            "小栞意识到自己开始狠狠吃饭，竟然只是为了有力气直播跳舞给大家看？",
            "问题还没搞明白\n本来只想换一张显卡最后却要把整台电脑全换掉",
            "原本只是想给这个电脑换显卡\n结果最后却要把整台电脑全部换掉",
            "大家都说“完整保留这段原话”\n他说“引号换行后也不能丢”",
            '他说"我本来只想换一张显卡\n最后却要把整台电脑全部换掉"',
        ]
        for size in ((1920, 1080), (1280, 720), (960, 540)):
            for position in ("center", "top", "bottom"):
                for title in samples:
                    with self.subTest(size=size, position=position, title=title):
                        canvas = Image.new("RGB", size)
                        rows = generator._layout_text(ImageDraw.Draw(canvas), title, *size, position)
                        expected = "".join(generator.build_cover_lines(title)).replace("\n", "")
                        self.assertEqual("".join(row["text"] for row in rows), expected)
                        self.assertNotIn("…", "".join(row["text"] for row in rows))
                        if title == samples[1]:
                            self.assertGreater(len(rows), 2)
                        layout = generator._text_layout(*size, position)
                        previous_bottom = 0
                        for row in rows:
                            x0, y0, x1, y1 = row["bbox"]
                            self.assertGreaterEqual(x0, layout["safe_left"])
                            self.assertLessEqual(x1, layout["safe_right"])
                            self.assertGreaterEqual(y0, layout["top"])
                            self.assertGreater(y0, previous_bottom)
                            self.assertLessEqual(y1, layout["bottom"])
                            previous_bottom = y1
                            ink = Image.new("RGB", size)
                            generator._draw_outlined_text(
                                ImageDraw.Draw(ink), row["position"], row["text"], row["font"],
                                row["fill"], row["stroke_width"], row["shadow_offset"],
                            )
                            pixels = ink.getbbox()
                            self.assertIsNotNone(pixels)
                            self.assertGreaterEqual(pixels[0], x0)
                            self.assertGreaterEqual(pixels[1], y0)
                            self.assertLessEqual(pixels[2], x1)
                            self.assertLessEqual(pixels[3], y1)

    def test_unreadably_long_copy_fails_without_producing_a_truncated_cover(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "frame.png"
            output = Path(directory) / "cover.jpg"
            Image.new("RGB", (1920, 1080)).save(source)
            generator = CoverGenerator({"text_max_width": 1})
            with self.assertRaisesRegex(ValueError, "supply shorter coverText"):
                generator.add_text_to_cover(str(source), "铺垫文字\n完整保留这段原话", output_path=str(output))
            self.assertFalse(output.exists())

    def test_visual_score_prefers_a_detailed_frame_over_a_flat_frame(self):
        flat = Image.new("RGB", (320, 180), (120, 120, 120))
        detailed = Image.new("RGB", (320, 180), (30, 30, 30))
        pixels = detailed.load()
        for y in range(180):
            for x in range(320):
                if (x // 12 + y // 12) % 2:
                    pixels[x, y] = (235, 180, 75)

        self.assertGreater(
            CoverGenerator._score_frame(detailed),
            CoverGenerator._score_frame(flat),
        )


if __name__ == "__main__":
    unittest.main()
