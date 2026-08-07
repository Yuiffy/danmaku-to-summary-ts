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
    status_code = 200
    headers = {}
    text = ""
    elapsed = None

    def __init__(self, body):
        self.body = body

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
