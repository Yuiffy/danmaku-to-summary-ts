import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = ROOT / "src" / "scripts"
MODULE_PATH = SCRIPT_DIR / "tuzi_chat_completions.py"

sys.path.insert(0, str(SCRIPT_DIR))
spec = importlib.util.spec_from_file_location("tuzi_chat_completions_under_test", MODULE_PATH)
tuzi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tuzi)


class FakeResponse:
    headers = {}
    elapsed = None

    def __init__(self, body, status_code=200, text=""):
        self.body = body
        self.status_code = status_code
        self.text = text

    def json(self):
        return self.body


class FakeElapsed:
    @staticmethod
    def total_seconds():
        return 0.1


class TuziTextCompletionTests(unittest.TestCase):
    def test_extracts_standard_chat_completion_text(self):
        result = {
            "choices": [{
                "message": {"role": "assistant", "content": "  漫画脚本  "},
                "finish_reason": "stop",
            }]
        }

        self.assertEqual(tuzi.extract_tuzi_text_content(result), "漫画脚本")

    def test_extracts_content_parts_and_responses_output(self):
        chat_result = {
            "choices": [{
                "message": {
                    "content": [
                        {"type": "text", "text": "第一段"},
                        {"type": "output_text", "text": {"value": "第二段"}},
                    ]
                }
            }]
        }
        responses_result = {
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": "兜底文本"}],
            }]
        }

        self.assertEqual(tuzi.extract_tuzi_text_content(chat_result), "第一段\n第二段")
        self.assertEqual(tuzi.extract_tuzi_text_content(responses_result), "兜底文本")

    def test_chat_request_matches_documented_non_streaming_shape(self):
        response = FakeResponse({
            "id": "resp_test",
            "object": "chat.completion",
            "choices": [{
                "message": {"role": "assistant", "content": "TUZI_OK"},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
        })

        with (
            patch.object(tuzi, "request_tuzi_with_retry", side_effect=lambda _, request: request()),
            patch.object(tuzi.requests, "post", return_value=response) as post,
        ):
            content = tuzi.call_tuzi_chat_completions(
                prompt="只回复 TUZI_OK",
                system_prompt="接口测试",
                model="test-model",
                base_url="https://api.tu-zi.com/v1",
                api_key="secret",
                temperature=0,
                max_tokens=4096,
            )

        self.assertEqual(content, "TUZI_OK")
        args, kwargs = post.call_args
        self.assertEqual(args[0], "https://api.tu-zi.com/v1/chat/completions")
        self.assertEqual(kwargs["headers"]["Accept"], "application/json")
        self.assertFalse(kwargs["json"]["stream"])
        self.assertEqual(kwargs["json"]["max_tokens"], 4096)
        self.assertEqual(kwargs["json"]["messages"][0]["role"], "system")
        self.assertEqual(kwargs["json"]["messages"][1]["role"], "user")

    def test_phase_aware_response_extraction_matches_node_behavior(self):
        def message(phase, text, role="assistant"):
            return {"type": "message", "role": role, "phase": phase,
                    "content": [{"type": "output_text", "text": text}]}
        cases = [
            ({"output": [message("commentary", "Progress"), message("final_answer", "Final")]}, "Final"),
            ({"output_text": "Progress\nFinal", "choices": [{"message": {"content": "Other"}}],
              "output": [message("commentary", "Progress"), message("final_answer", "Final")]}, "Final"),
            ({"output": [message("final_answer", "I will first quote the source."),
                         message("commentary", "Progress"), message("final_answer", "Part two")]},
             "I will first quote the source.\nPart two"),
            ({"output_text": "Progress", "output": [message("commentary", "Progress")]}, ""),
            ({"output": [message("commentary", "Progress"), message(None, "Legacy final")]}, "Legacy final"),
            ({"output": [message("final_answer", "Input", role="user"), message("commentary", "Progress")]}, ""),
        ]
        for response, expected in cases:
            with self.subTest(expected=expected, response=response):
                self.assertEqual(tuzi.extract_tuzi_text_content(response), expected)

    def test_refused_final_never_falls_back_to_progress_text(self):
        result = {"output_text": "Progress", "output": [
            {"type": "message", "role": "assistant", "phase": "commentary",
             "content": [{"type": "output_text", "text": "Progress"}]},
            {"type": "message", "role": "assistant", "phase": "final_answer",
             "content": [{"type": "refusal", "refusal": "Unavailable"}]},
        ]}
        self.assertEqual(tuzi.extract_tuzi_text_content(result), "")

    def test_non_array_output_preserves_legacy_aggregate_text(self):
        for output in ({}, "unexpected", 1, False, None):
            with self.subTest(output=output):
                self.assertEqual(tuzi.extract_tuzi_text_content({"output_text": "Valid final", "output": output}), "Valid final")

    def test_chat_request_supports_local_multimodal_images(self):
        response = FakeResponse({
            "choices": [{
                "message": {"role": "assistant", "content": '{"candidateIndex":5}'},
                "finish_reason": "stop",
            }],
        })
        image_path = ROOT / "tests" / "fixtures" / "vision-candidate.jpg"

        with (
            patch.object(tuzi, "request_tuzi_with_retry", side_effect=lambda _, request: request()),
            patch.object(tuzi.requests, "post", return_value=response) as post,
            patch.object(tuzi.os.path, "isfile", return_value=True),
            patch.object(tuzi, "encode_image_to_base64", return_value="data:image/jpeg;base64,AA=="),
        ):
            content = tuzi.call_tuzi_chat_completions(
                prompt="选择候选",
                image_paths=[str(image_path)],
                model="vision-model",
                base_url="https://api.example/v1",
                api_key="secret",
            )

        self.assertEqual(content, '{"candidateIndex":5}')
        user_content = post.call_args.kwargs["json"]["messages"][-1]["content"]
        self.assertEqual(user_content[0], {"type": "text", "text": "选择候选"})
        self.assertEqual(user_content[1]["type"], "image_url")
        self.assertEqual(user_content[1]["image_url"]["detail"], "high")
        self.assertEqual(
            user_content[1]["image_url"]["url"],
            "data:image/jpeg;base64,AA==",
        )

    def test_empty_response_summary_is_prompt_free(self):
        result = {
            "object": "chat.completion",
            "choices": [{
                "message": {"content": "", "reasoning_content": "hidden"},
                "finish_reason": "length",
            }],
            "usage": {"completion_tokens": 2000},
        }

        summary = tuzi.summarize_tuzi_text_response(result)

        self.assertIn('"finish_reason":"length"', summary)
        self.assertIn('"completion_tokens":2000', summary)
        self.assertNotIn("hidden", summary)

    def test_daiyu_chat_request_enables_thinking(self):
        response = FakeResponse({
            "choices": [{
                "message": {"role": "assistant", "content": "DAIYU_OK"},
                "finish_reason": "stop",
            }],
        })

        with (
            patch.object(tuzi, "request_tuzi_with_retry", side_effect=lambda _, request: request()),
            patch.object(tuzi.requests, "post", return_value=response) as post,
        ):
            content = tuzi.call_daiyu_chat_completions(
                prompt="只回复 DAIYU_OK",
                model="gpt-5.6-luna",
                base_url="https://daiyu.example/v1",
                api_key="secret",
                thinking=True,
                thinking_budget_tokens=8192,
            )

        self.assertEqual(content, "DAIYU_OK")
        self.assertEqual(post.call_args.kwargs["json"]["model"], "gpt-5.6-luna")
        self.assertEqual(
            post.call_args.kwargs["json"]["thinking"],
            {"type": "enabled", "budget_tokens": 8192},
        )

    def test_daiyu_responses_request_preserves_cache_prefix_before_images(self):
        response = FakeResponse({
            "id": "resp_native",
            "status": "completed",
            "output": [{
                "type": "message",
                "status": "completed",
                "content": [{"type": "output_text", "text": "RESPONSES_OK"}],
            }],
            "usage": {
                "input_tokens": 12000,
                "input_tokens_details": {
                    "cached_tokens": 10000,
                    "cache_write_tokens": 2000,
                },
                "output_tokens": 900,
                "output_tokens_details": {"reasoning_tokens": 700},
                "total_tokens": 12900,
            },
        })
        prompt_cache = {
            "enabled": True,
            "prefix": "全量直播事实",
            "suffix": "\n漫画任务规则",
            "requestKey": "live:test",
            "ttl": "30m",
            "rolloutPercent": 100,
            "rolloutBucket": 1,
            "sharedPromptCacheKey": "a" * 64,
            "sharedPromptPrefixChars": 6,
        }
        image_path = ROOT / "tests" / "fixtures" / "vision-candidate.jpg"

        with (
            patch.object(tuzi, "request_tuzi_with_retry", side_effect=lambda _, request: request()),
            patch.object(tuzi.requests, "post", return_value=response) as post,
            patch.object(tuzi.os.path, "isfile", return_value=True),
            patch.object(tuzi, "encode_image_to_base64", return_value="data:image/jpeg;base64,AA=="),
        ):
            content, metadata = tuzi.call_daiyu_chat_completions(
                prompt="全量直播事实\n漫画任务规则",
                system_prompt="稳定系统指令",
                image_paths=[str(image_path)],
                model="gpt-5.6-luna",
                base_url="https://daiyu.example/v1",
                api_key="secret",
                max_tokens=4096,
                thinking=True,
                prompt_cache=prompt_cache,
                return_metadata=True,
                api_mode="responses",
                reasoning_effort="high",
            )

        self.assertEqual(content, "RESPONSES_OK")
        args, kwargs = post.call_args
        self.assertEqual(args[0], "https://daiyu.example/v1/responses")
        payload = kwargs["json"]
        self.assertEqual(payload["max_output_tokens"], 4096)
        self.assertEqual(payload["reasoning"], {"effort": "high"})
        self.assertEqual(payload["instructions"], "稳定系统指令")
        self.assertFalse(payload["stream"])
        self.assertFalse(payload["store"])
        self.assertNotIn("messages", payload)
        self.assertNotIn("max_tokens", payload)
        self.assertNotIn("thinking", payload)
        self.assertNotIn("temperature", payload)
        content_parts = payload["input"][0]["content"]
        self.assertEqual(content_parts[0], {
            "type": "input_text",
            "text": "全量直播事实",
        })
        self.assertEqual(content_parts[1], {
            "type": "input_text",
            "text": "\n漫画任务规则",
        })
        self.assertEqual(content_parts[2]["type"], "input_image")
        self.assertEqual(content_parts[2]["image_url"], "data:image/jpeg;base64,AA==")
        self.assertEqual(metadata["apiModeRequested"], "responses")
        self.assertEqual(metadata["apiModeUsed"], "responses")
        self.assertEqual(metadata["explicitPromptCache"], "implicit_routed")
        self.assertNotIn("prompt_cache_options", payload)
        self.assertEqual(metadata["cachedTokens"], 10000)
        self.assertEqual(metadata["cacheWriteTokens"], 2000)

    def test_daiyu_responses_rejection_falls_back_to_chat_completions(self):
        responses_error = FakeResponse({}, status_code=400, text="unsupported responses payload")
        chat_response = FakeResponse({
            "choices": [{
                "message": {"role": "assistant", "content": "CHAT_FALLBACK_OK"},
                "finish_reason": "stop",
            }],
            "usage": {},
        })

        with (
            patch.object(tuzi, "request_tuzi_with_retry", side_effect=lambda _, request: request()),
            patch.object(tuzi.requests, "post", side_effect=[responses_error, chat_response]) as post,
        ):
            content, metadata = tuzi.call_daiyu_chat_completions(
                prompt="只回复 CHAT_FALLBACK_OK",
                model="gpt-5.6-luna",
                base_url="https://daiyu.example/v1",
                api_key="secret",
                thinking=True,
                thinking_budget_tokens=8192,
                return_metadata=True,
                api_mode="responses",
            )

        self.assertEqual(content, "CHAT_FALLBACK_OK")
        self.assertEqual(post.call_count, 2)
        self.assertEqual(post.call_args_list[0].args[0], "https://daiyu.example/v1/responses")
        self.assertEqual(post.call_args_list[1].args[0], "https://daiyu.example/v1/chat/completions")
        fallback_payload = post.call_args_list[1].kwargs["json"]
        self.assertEqual(
            fallback_payload["thinking"],
            {"type": "enabled", "budget_tokens": 8192},
        )
        self.assertEqual(metadata["apiModeRequested"], "responses")
        self.assertEqual(metadata["apiModeUsed"], "chatCompletions")
        self.assertIn("HTTP 400", metadata["apiModeFallbackReason"])

    def test_daiyu_legacy_gpt5_model_is_normalized_to_luna(self):
        response = FakeResponse({
            "choices": [{
                "message": {"role": "assistant", "content": "LUNA_OK"},
                "finish_reason": "stop",
            }],
        })
        legacy_model = "gpt-5.4-" + "mini"

        with (
            patch.object(tuzi, "request_tuzi_with_retry", side_effect=lambda _, request: request()),
            patch.object(tuzi.requests, "post", return_value=response) as post,
        ):
            content = tuzi.call_daiyu_chat_completions(
                prompt="只回复 LUNA_OK",
                model=legacy_model,
                base_url="https://daiyu.example/v1",
                api_key="secret",
            )

        self.assertEqual(content, "LUNA_OK")
        self.assertEqual(post.call_args.kwargs["json"]["model"], "gpt-5.6-luna")

    def test_images_edits_sends_up_to_twelve_reference_images(self):
        response = FakeResponse({"data": [{"b64_json": "unused"}]})
        response.elapsed = FakeElapsed()

        with tempfile.TemporaryDirectory() as temp_dir:
            reference_paths = []
            for index in range(13):
                image_path = Path(temp_dir) / f"reference-{index + 1:02d}.png"
                image_path.write_bytes(b"test-image")
                reference_paths.append(str(image_path))

            with (
                patch.object(tuzi, "check_image_api_rate_limit", return_value=True),
                patch.object(tuzi.requests, "post", return_value=response) as post,
                patch.object(tuzi, "try_extract_image_from_data_items", return_value="result.png"),
                patch.object(tuzi, "record_successful_image_api_call"),
                patch.object(tuzi, "append_image_generation_attempt"),
                patch.object(tuzi, "log_tuzi_response_identifiers", return_value={}),
            ):
                result = tuzi.call_tuzi_images_edits(
                    prompt="generate",
                    reference_image_path=reference_paths,
                    base_url="https://api.example/v1",
                    api_key="secret",
                    use_tuzi_retry=False,
                )

        self.assertEqual(result, "result.png")
        uploaded_files = post.call_args.kwargs["files"]
        self.assertEqual(len(uploaded_files), 12)
        self.assertEqual(
            [file_tuple[1][0] for file_tuple in uploaded_files],
            [f"reference-{index:02d}.png" for index in range(1, 13)],
        )


if __name__ == "__main__":
    unittest.main()
