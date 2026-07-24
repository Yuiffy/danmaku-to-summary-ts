import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = ROOT / "src" / "scripts"
MODULE_PATH = SCRIPT_DIR / "ai_comic_generator.py"

sys.path.insert(0, str(SCRIPT_DIR))
spec = importlib.util.spec_from_file_location("ai_comic_generator_text_test", MODULE_PATH)
comic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comic)

import tuzi_chat_completions


class ComicTextProviderTests(unittest.TestCase):
    def test_tuzi_failure_reaches_daiyu_without_duplicate_highlight_or_os_error(self):
        highlight = (
            "[2m] UNIQUE_HIGHLIGHT 主播检查画质。\n"
            "[90m] 主播挑战游戏关卡。\n"
            "[220m] 主播和观众道晚安。"
        )
        daiyu_script = (
            "分镜1：主播检查直播画质，观众发送鼓励弹幕。\n"
            "分镜2：主播专注挑战游戏关卡。\n"
            "分镜3：主播成功进入新阶段。\n"
            "分镜4：主播微笑着和观众道晚安。"
        )
        config = {
            "aiServices": {"gemini": {}},
            "ai": {
                "text": {
                    "tuZi": {
                        "enabled": True,
                        "apiKey": "tuzi-key",
                        "baseUrl": "https://api.tu-zi.com",
                        "model": "gpt-5.6-luna",
                        "temperature": 0.25,
                        "maxTokens": 12345,
                    }
                },
                "providers": {
                    "daiYu": {
                        "baseURL": "https://daiyu.example/v1",
                        "apiKey": "daiyu-key",
                        "textTemperature": 0.4,
                        "textMaxTokens": 23456,
                    }
                },
                "streamerRegistry": {},
                "roomSettings": {},
            },
            "asr": {},
            "roomSettings": {},
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            with (
                patch.object(comic, "load_config", return_value=config),
                patch.object(comic, "get_project_root", return_value=temp_dir),
                patch.object(comic, "is_tuzi_text_configured", return_value=True),
                patch.object(comic, "get_tuzi_text_api_key", return_value="tuzi-key"),
                patch.object(comic.shutil, "which", return_value=None),
                patch.object(comic, "HAS_GOOGLE_GENAI", False),
                patch.object(
                    tuzi_chat_completions,
                    "call_tuzi_chat_completions",
                    side_effect=[None, daiyu_script],
                ) as call_text,
            ):
                result, generated = comic.generate_comic_content_with_ai(
                    highlight,
                    room_id="25788785",
                )

        self.assertTrue(generated)
        self.assertIn("观众发送鼓励弹幕", result)
        self.assertEqual(call_text.call_count, 2)

        tuzi_call = call_text.call_args_list[0].kwargs
        daiyu_call = call_text.call_args_list[1].kwargs
        self.assertEqual(tuzi_call["max_tokens"], 12345)
        self.assertEqual(daiyu_call["max_tokens"], 23456)
        self.assertEqual(tuzi_call["temperature"], 0.25)
        self.assertEqual(daiyu_call["temperature"], 0.4)
        self.assertEqual(tuzi_call["prompt"].count("UNIQUE_HIGHLIGHT"), 1)
        self.assertNotIn("UNIQUE_HIGHLIGHT", tuzi_call["system_prompt"])
        self.assertEqual(daiyu_call["base_url"], "https://daiyu.example/v1")
        self.assertEqual(comic.get_comic_script_meta()["provider"], "daiYu")


if __name__ == "__main__":
    unittest.main()
