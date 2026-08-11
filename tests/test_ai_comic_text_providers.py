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
                    "sharedPromptCache": {
                        "enabled": True,
                        "explicitRolloutPercent": 0,
                    },
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
                "roomSettings": {
                    "25788785": {
                        "fullLiveContextExperiment": {
                            "enabled": True,
                            "tasks": ["comic"],
                            "promptCacheRolloutPercent": 100,
                        }
                    }
                },
            },
            "asr": {},
            "roomSettings": {},
        }

        usage_attempt = {
            "provider": "daiYu",
            "model": "gpt-5.6-luna",
            "status": "success",
            "promptTokens": 10000,
            "cachedTokens": 8000,
            "cacheWriteTokens": 2000,
            "completionTokens": 600,
            "reasoningTokens": 400,
            "totalTokens": 10600,
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            with (
                patch.object(comic, "load_config", return_value=config),
                patch.object(comic, "get_project_root", return_value=temp_dir),
                patch.object(comic.shutil, "which", return_value=None),
                patch.object(comic, "HAS_GOOGLE_GENAI", False),
                patch.object(comic, "print") as print_log,
                patch.object(
                    comic,
                    "call_daiyu_chat_completions",
                    return_value=(daiyu_script, usage_attempt),
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
        self.assertTrue(daiyu_call["prompt_cache"]["enabled"])
        self.assertEqual(daiyu_call["prompt_cache"]["rolloutPercent"], 100)
        self.assertEqual(comic.get_comic_script_meta()["provider"], "daiYu")
        self.assertEqual(comic.get_comic_script_meta()["attempts"], [usage_attempt])
        usage_logs = [
            str(call.args[0])
            for call in print_log.call_args_list
            if call.args and str(call.args[0]).startswith("[COMIC_SCRIPT_USAGE]")
        ]
        self.assertEqual(len(usage_logs), 1)
        self.assertIn('"promptTokens":10000', usage_logs[0])
        self.assertIn('"cachedTokens":8000', usage_logs[0])
        self.assertIn('"uncachedPromptTokens":2000.0', usage_logs[0])
        self.assertIn('"cacheWriteTokens":2000', usage_logs[0])
        self.assertIn('"completionTokens":600', usage_logs[0])
        self.assertIn('"reasoningTokens":400', usage_logs[0])
        self.assertIn('"totalTokens":10600', usage_logs[0])
        self.assertIn('"cacheHitRatio":0.8', usage_logs[0])


if __name__ == "__main__":
    unittest.main()
