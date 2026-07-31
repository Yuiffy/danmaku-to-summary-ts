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

class ComicTextProviderTests(unittest.TestCase):
    def test_daiyu_fallback_uses_gpt56_and_thinking_without_duplicate_highlight(self):
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
                    "daiYu": {
                        "enabled": True,
                        "apiKey": "daiyu-key",
                        "baseUrl": "https://daiyu.example/v1",
                        "model": "gpt-5.6-luna",
                        "temperature": 0.25,
                        "maxTokens": 12345,
                        "thinking": {
                            "enabled": True,
                            "budgetTokens": 8192,
                        },
                    }
                },
                "providers": {},
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
                patch.object(comic.shutil, "which", return_value=None),
                patch.object(comic, "HAS_GOOGLE_GENAI", False),
                patch.object(
                    comic,
                    "call_daiyu_chat_completions",
                    return_value=daiyu_script,
                ) as call_text,
            ):
                result, generated = comic.generate_comic_content_with_ai(
                    highlight,
                    room_id="25788785",
                )

        self.assertTrue(generated)
        self.assertIn("观众发送鼓励弹幕", result)
        self.assertEqual(call_text.call_count, 1)

        daiyu_call = call_text.call_args.kwargs
        self.assertEqual(daiyu_call["model"], "gpt-5.6-luna")
        self.assertEqual(daiyu_call["max_tokens"], 12345)
        self.assertEqual(daiyu_call["temperature"], 0.25)
        self.assertTrue(daiyu_call["thinking"])
        self.assertEqual(daiyu_call["thinking_budget_tokens"], 8192)
        self.assertEqual(daiyu_call["prompt"].count("UNIQUE_HIGHLIGHT"), 1)
        self.assertNotIn("UNIQUE_HIGHLIGHT", daiyu_call["system_prompt"])
        self.assertEqual(daiyu_call["base_url"], "https://daiyu.example/v1")
        self.assertEqual(comic.get_comic_script_meta()["provider"], "daiYu")


if __name__ == "__main__":
    unittest.main()
