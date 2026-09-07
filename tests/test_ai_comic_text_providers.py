import importlib.util
import hashlib
import json
import subprocess
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
    def test_shared_explicit_completion_states_match_the_node_contract(self):
        cases = json.loads((ROOT / "tests" / "fixtures" / "text-completion-states.json").read_text(encoding="utf-8"))
        for case in cases:
            with self.subTest(metadata=case["metadata"]):
                self.assertEqual(comic.has_incomplete_text_generation(case["metadata"]), case["incomplete"])

    def test_shared_source_artifact_is_context_independent_and_rejects_stale_or_corrupt_data(self):
        config = {"ai": {"text": {"sharedPromptCache": {"enabled": True}}}, "asr": {}}
        source = "Recorded exact fact."
        early = comic.build_shared_live_source_prefix(source, "1", config, {"liveTitle": "live"})
        late = comic.build_shared_live_source_prefix(source, "1", config, {"liveContent": {"games": ["verified"]}})
        self.assertEqual(early, late)
        with tempfile.TemporaryDirectory() as directory:
            highlight = str(Path(directory) / "sample_AI_HIGHLIGHT.txt")
            artifact = Path(directory) / "sample_SHARED_LIVE_SOURCE.json"
            payload = {"schemaVersion": 1, "roomId": "1", "sharedPrefix": early,
                       "sourceSha256": hashlib.sha256(source.encode()).hexdigest(),
                       "sharedPrefixSha256": hashlib.sha256(early.encode()).hexdigest()}
            artifact.write_text(json.dumps(payload), encoding="utf-8")
            self.assertEqual(comic.load_shared_live_source_prefix(highlight, source, "1", config), early)
            self.assertIsNone(comic.load_shared_live_source_prefix(highlight, "changed source", "1", config))
            self.assertIsNone(comic.load_shared_live_source_prefix(highlight, source, "2", config))
            payload["sharedPrefix"] += "tampered"
            artifact.write_text(json.dumps(payload), encoding="utf-8")
            self.assertIsNone(comic.load_shared_live_source_prefix(highlight, source, "1", config))
            artifact.write_text("[]", encoding="utf-8")
            self.assertIsNone(comic.load_shared_live_source_prefix(highlight, source, "1", config))

    def run_managed_node(self, result=None, error=None):
        config = {"ai": {"text": {}, "comic": {}}, "roomSettings": {}, "asr": {}}
        with (
            patch.object(comic, "load_config", return_value=config),
            patch.object(comic.shutil, "which", return_value="node"),
            patch.object(comic, "get_multi_character_description", return_value="host"),
            patch.object(comic, "build_comic_generation_prompt", return_value="source and instructions"),
            patch.object(comic, "postprocess_generated_comic_script", side_effect=lambda text, *args, **kwargs: text),
            patch.object(comic.subprocess, "run", return_value=result, side_effect=error) as run,
            patch.object(comic, "call_daiyu_chat_completions") as fallback,
            patch.object(comic, "return_comic_script_failure", return_value=("", False)) as failure,
            patch.object(comic, "print"),
        ):
            output = comic.generate_comic_content_with_ai("source", "1")
        return output, run, fallback, failure

    def test_node_owns_the_retry_deadline_and_returns_success_without_python_retry(self):
        script = "A complete drawable storyboard with source-grounded scenes and a closing scene."
        meta = {"provider": "daiYu", "model": "gpt-5.6-luna", "attempts": [{"status": "success"}]}
        result = subprocess.CompletedProcess([], 0, script.encode(), ("[[TEXT_GENERATION_META]] " + json.dumps(meta)).encode())
        output, run, fallback, failure = self.run_managed_node(result)
        self.assertEqual(output, (script, True))
        self.assertEqual(run.call_args.kwargs["timeout"], 245)
        self.assertIn("--total-timeout-ms", run.call_args.args[0])
        self.assertIn("--min-output-chars", run.call_args.args[0])
        fallback.assert_not_called()
        failure.assert_not_called()

    def test_managed_node_failure_does_not_start_a_second_provider_chain(self):
        attempts = [{"provider": "daiYu", "status": "failure", "error": "timeout"}]
        error = {"owner": "node-text-generator", "error": "exhausted", "attempts": attempts}
        result = subprocess.CompletedProcess([], 1, b"", ("[[TEXT_GENERATION_ERROR]] " + json.dumps(error)).encode())
        output, run, fallback, failure = self.run_managed_node(result)
        self.assertEqual(output, ("", False))
        fallback.assert_not_called()
        self.assertEqual(failure.call_args.args[-1], attempts)

    def test_all_node_attempts_are_logged_on_success_or_failure_without_new_requests(self):
        attempts = [
            {"provider": "daiYu", "status": "failure", "usageUnknown": False, "requestId": "known-failure", "promptTokens": 100, "completionTokens": 25},
            {"provider": "daiYu", "status": "failure", "usageUnknown": True, "requestId": "unknown-failure"},
        ]
        script = "A complete drawable storyboard with source-grounded scenes and a closing scene."
        for successful in (False, True):
            with self.subTest(successful=successful):
                rows = attempts + ([{"provider": "tuZi", "status": "success", "requestId": "final-success", "promptTokens": 200, "completionTokens": 50}] if successful else [])
                payload = {"provider": "daiYu", "model": "same-model", "attempts": rows, "error": "failed"}
                marker = "TEXT_GENERATION_META" if successful else "TEXT_GENERATION_ERROR"
                process = subprocess.CompletedProcess([], 0 if successful else 1, script.encode() if successful else b"",
                    (f"[[{marker}]] " + json.dumps(payload)).encode())
                with patch.object(comic, "log_comic_script_token_usage") as usage_log:
                    output, run, fallback, failure = self.run_managed_node(process)
                self.assertEqual([call.args[0] for call in usage_log.call_args_list], rows)
                self.assertEqual(run.call_count, 1)
                fallback.assert_not_called()
                self.assertEqual(output[1], successful)

    def test_comic_usage_log_retains_request_identity_failure_status_and_unknown_values(self):
        attempts = [
            {"provider": "daiYu", "model": "same-model", "status": "failure", "requestStarted": True,
             "usageUnknown": True, "httpStatus": 502, "requestId": "failed-http"},
            {"provider": "daiYu", "status": "failure", "requestStarted": True, "usageUnknown": False,
             "promptTokens": 100, "completionTokens": 25, "requestId": "rejected-text", "responseId": "known-response"},
        ]
        with patch.object(comic, "print") as logged:
            for attempt in attempts:
                comic.log_comic_script_token_usage(attempt)
        rows = [json.loads(call.args[0].split(" ", 1)[1]) for call in logged.call_args_list]
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["status"], "failure")
        self.assertEqual(rows[0]["requestId"], "failed-http")
        self.assertEqual(rows[0]["httpStatus"], 502)
        self.assertTrue(rows[0]["usageUnknown"])
        self.assertIsNone(rows[0]["promptTokens"])
        self.assertIsNone(rows[0]["completionTokens"])
        self.assertFalse(rows[1]["usageUnknown"])
        self.assertEqual(rows[1]["promptTokens"], 100)
        self.assertEqual(rows[1]["completionTokens"], 25)
        self.assertEqual(rows[1]["responseId"], "known-response")

    def test_parent_deadline_preserves_unknown_outcome_without_blind_retry(self):
        output, run, fallback, failure = self.run_managed_node(error=subprocess.TimeoutExpired("node", 245))
        self.assertEqual(output, ("", False))
        fallback.assert_not_called()
        self.assertEqual(failure.call_args.args[-1][0]["status"], "outcome_unknown")

    def test_parent_timeout_reuses_a_completed_hash_verified_result(self):
        script = "A complete source-grounded storyboard that has already been generated before process exit."
        metadata = {"provider": "daiYu", "model": "gpt-5.6-luna", "attempts": [{"status": "success"}],
                    "textSha256": hashlib.sha256(script.encode()).hexdigest()}
        timeout = subprocess.TimeoutExpired("node", 245, output=script.encode(),
                    stderr=("[[TEXT_GENERATION_META]] " + json.dumps(metadata)).encode())
        output, run, fallback, failure = self.run_managed_node(error=timeout)
        self.assertEqual(output, (script, True))
        fallback.assert_not_called()
        failure.assert_not_called()

    def test_node_success_with_corrupted_stdout_is_not_used_for_an_image(self):
        metadata = {"textSha256": "0" * 64}
        result = subprocess.CompletedProcess([], 0, b"This is a long but corrupted storyboard that must not be accepted.",
                  ("[[TEXT_GENERATION_META]] " + json.dumps(metadata)).encode())
        output, run, fallback, failure = self.run_managed_node(result)
        self.assertEqual(output, ("", False))
        self.assertIn("hash mismatch", failure.call_args.args[2])
        fallback.assert_not_called()

    def test_invalid_completed_script_keeps_reported_usage_without_retry(self):
        script = "A tiny script with a desk and a smile in it."
        self.assertGreaterEqual(len(script), 40)
        self.assertFalse(comic.is_valid_comic_script(script))
        attempts = [{"provider": "daiYu", "model": "gpt-5.6-luna", "status": "success",
                     "promptTokens": 1200, "completionTokens": 40, "requestId": "completed-request"}]
        metadata = {"attempts": attempts, "textSha256": hashlib.sha256(script.encode()).hexdigest()}
        result = subprocess.CompletedProcess([], 0, script.encode(),
                  ("[[TEXT_GENERATION_META]] " + json.dumps(metadata)).encode())
        output, run, fallback, failure = self.run_managed_node(result)
        self.assertEqual(output, ("", False))
        self.assertEqual(failure.call_args.args[-1], attempts)
        self.assertEqual(run.call_count, 1)
        fallback.assert_not_called()

    def test_late_process_exit_does_not_hide_a_completed_but_invalid_script(self):
        script = "A tiny script with a desk and a smile in it."
        attempts = [{"provider": "daiYu", "status": "success", "promptTokens": 1200, "completionTokens": 40}]
        metadata = {"attempts": attempts, "textSha256": hashlib.sha256(script.encode()).hexdigest()}
        timeout = subprocess.TimeoutExpired("node", 245, output=script.encode(),
                  stderr=("[[TEXT_GENERATION_META]] " + json.dumps(metadata)).encode())
        output, run, fallback, failure = self.run_managed_node(error=timeout)
        self.assertEqual(output, ("", False))
        self.assertEqual(failure.call_args.args[-1], attempts)
        self.assertIn("no valid comic script", failure.call_args.args[2])
        self.assertEqual(run.call_count, 1)
        fallback.assert_not_called()

    def test_incomplete_output_at_deadline_retains_known_provider_usage(self):
        script = "A complete source-grounded storyboard that did not fully reach the Python reader."
        attempts = [{"provider": "daiYu", "status": "success", "promptTokens": 1200, "completionTokens": 80}]
        metadata = {"attempts": attempts, "textSha256": hashlib.sha256(script.encode()).hexdigest()}
        timeout = subprocess.TimeoutExpired("node", 245, output=script[:12].encode(),
                  stderr=("[[TEXT_GENERATION_META]] " + json.dumps(metadata)).encode())
        output, run, fallback, failure = self.run_managed_node(error=timeout)
        self.assertEqual(output, ("", False))
        self.assertEqual(failure.call_args.args[-1], attempts)
        self.assertIn("deadline", failure.call_args.args[2])
        self.assertEqual(run.call_count, 1)
        fallback.assert_not_called()

    def test_script_cache_rejects_old_policy_but_reuses_current_policy(self):
        source = "Recorded source facts."
        script = "A complete storyboard with enough visible characters and a clearly finished closing scene."
        config = {"aiServices": {}, "ai": {"comic": {"outputLockEnabled": False}}, "roomSettings": {}}
        storytelling = {"variant": "control", "bucket": 0, "immersivePercent": 0,
                        "screenshotMode": "ambient", "assignmentHash": "fixed-assignment"}
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(comic, "load_config", return_value=config),
            patch.object(comic, "get_existing_generated_file", return_value=None),
            patch.object(comic, "load_full_live_context_sidecar", return_value=None),
            patch.object(comic, "load_shared_live_source_prefix", return_value=None),
            patch.object(comic, "sanitize_highlight_for_comic_script", return_value=source),
            patch.object(comic, "select_comic_storytelling_variant", return_value=storytelling),
            patch.object(comic, "load_live_generation_context", return_value={}),
            patch.object(comic, "resolve_extra_appeared_streamers", return_value=[]),
            patch.object(comic, "build_comic_prompt", return_value=("", "", False)) as build_prompt,
            patch.object(comic, "write_comic_generation_meta"),
            patch.object(comic, "print"),
        ):
            highlight = Path(directory) / "sample_AI_HIGHLIGHT.txt"
            highlight.write_text(source, encoding="utf-8")
            script_path = Path(directory) / "sample_COMIC_SCRIPT.txt"
            script_path.write_text(script, encoding="utf-8")
            comic.write_comic_script_meta(str(script_path), {"status": "success"}, "1", source, [], {}, storytelling)
            metadata_path = Path(comic.comic_script_meta_path(str(script_path)))
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            version = comic.COMIC_SCRIPT_POLICY_VERSION
            cases = [
                (version - 1, "success", [], False), (version, "success", [], True),
                (version, "failure", [], False),
                (version, "success", [{"status": "success", "finishReason": "max_output_tokens"}], False),
                (version, "success", [{"status": "failure", "finishReason": "max_output_tokens"}, {"status": "success", "finishReason": "stop"}], True),
            ]
            for policy, status, attempts, reusable in cases:
                with self.subTest(policy=policy, status=status, attempts=attempts):
                    metadata.update(policyVersion=policy, status=status, attempts=attempts)
                    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
                    build_prompt.reset_mock()
                    # Stop at prompt construction; no text or image API is called.
                    comic.generate_comic_from_highlight(str(highlight), "1")
                    expected = script if reusable else None
                    self.assertEqual(build_prompt.call_args.kwargs["existing_comic"], expected)
            for invalid_metadata in ("[]", "{broken JSON"):
                with self.subTest(invalid_metadata=invalid_metadata):
                    metadata_path.write_text(invalid_metadata, encoding="utf-8")
                    build_prompt.reset_mock()
                    comic.generate_comic_from_highlight(str(highlight), "1")
                    self.assertIsNone(build_prompt.call_args.kwargs["existing_comic"])

    def test_finished_image_is_reused_without_revalidating_or_regenerating_its_script(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(comic, "load_config", return_value={"aiServices": {}}),
            patch.object(comic, "build_comic_prompt") as build_prompt,
            patch.object(comic, "print"),
        ):
            highlight = Path(directory) / "sample_AI_HIGHLIGHT.txt"
            highlight.write_text("Recorded source facts.", encoding="utf-8")
            image_path = str(Path(directory) / "sample_COMIC_FACTORY.png")
            with patch.object(comic, "get_existing_generated_file", return_value=image_path):
                self.assertEqual(comic.generate_comic_from_highlight(str(highlight), "1"), image_path)
            build_prompt.assert_not_called()

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
                        "apiMode": "responses",
                        "model": "gpt-5.6-luna",
                        "temperature": 0.25,
                        "maxTokens": 12345,
                        "thinking": {
                            "enabled": True,
                            "budgetTokens": 8192,
                            "reasoningEffort": "high",
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
        self.assertEqual(daiyu_call["api_mode"], "responses")
        self.assertEqual(daiyu_call["reasoning_effort"], "high")
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
