import importlib.util
import os
import unittest


PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPT_PATH = os.path.join(PROJECT_ROOT, "scripts", "benchmark_funasr_models.py")
SPEC = importlib.util.spec_from_file_location("benchmark_funasr_models", SCRIPT_PATH)
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)


class BenchmarkFunASRModelsTests(unittest.TestCase):
    def test_srt_time_formatting(self):
        self.assertEqual(benchmark.format_srt_time(3661.234), "01:01:01,234")

    def test_character_similarity_ignores_spacing_and_punctuation(self):
        self.assertEqual(benchmark.character_similarity("你好，栞栞！", "你好 栞栞"), 1.0)
        self.assertLess(benchmark.character_similarity("你好", "再见"), 0.5)

    def test_review_window_includes_overlapping_segments(self):
        text = benchmark.segments_in_window(
            [
                {"start": 1, "end": 4, "text": "第一句", "emotion": "HAPPY"},
                {"start": 8, "end": 12, "text": "第二句", "emotion": "SAD"},
            ],
            0,
            10,
            include_emotion=True,
        )

        self.assertEqual(text, "[HAPPY]第一句 [SAD]第二句")


if __name__ == "__main__":
    unittest.main()
