"""Regression tests for the editorial clip-cover generator."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

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
