import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.scripts import clip_coordinate_comments as comments


class CoordinateCommentTests(unittest.TestCase):
    def clip(self, automatic=True):
        return {
            "publicationKind": "keyword_topic",
            "automaticPublicationRequired": automatic,
            "commentSuggestions": [{"timestamp": "04:45", "content": "饼干岁吃太好了", "sourceCueId": "G2636"}],
        }

    def test_manual_uploads_are_skipped_even_when_production_mode_is_on(self):
        self.assertFalse(comments.eligible_coordinate_comments(
            self.clip(automatic=False), {"clipTopics": {"coordinateComments": {"enabled": True, "mode": "auto"}}}
        ))

    def test_normalizes_invalid_suggestions(self):
        value = comments.normalize_suggestions([
            {"timestamp": "04:45", "content": "看这里"},
            {"timestamp": "bad", "content": "丢弃"},
            {"timestamp": "04:45", "content": "看这里"},
        ])
        self.assertEqual(value, [{"timestamp": "04:45", "content": "看这里"}])

    def test_publishes_once_and_reuses_receipt(self):
        async def send_comment(**_kwargs):
            return {"rpid_str": "319712492257"}

        with tempfile.TemporaryDirectory() as directory, patch.object(comments.comment, "send_comment", side_effect=send_comment) as send:
            result = asyncio.run(comments.publish_coordinate_comments(
                self.clip(), {"bvid": "BV1abc", "aid": 123}, object(),
                {"clipTopics": {"coordinateComments": {"enabled": True, "mode": "auto"}}},
                journal_directory=Path(directory),
            ))
            again = asyncio.run(comments.publish_coordinate_comments(
                self.clip(), {"bvid": "BV1abc", "aid": 123}, object(),
                {"clipTopics": {"coordinateComments": {"enabled": True, "mode": "auto"}}},
                journal_directory=Path(directory),
            ))
            self.assertEqual(result["status"], "published")
            self.assertEqual(again["status"], "published")
            self.assertEqual(send.call_count, 1)
            journal = next(Path(directory).glob("*.json"))
            self.assertEqual(json.loads(journal.read_text(encoding="utf-8"))["replyId"], "319712492257")

    def test_unknown_outcome_is_not_retried(self):
        async def send_comment(**_kwargs):
            raise TimeoutError("network timeout")

        with tempfile.TemporaryDirectory() as directory, patch.object(comments.comment, "send_comment", side_effect=send_comment) as send:
            first = asyncio.run(comments.publish_coordinate_comments(
                self.clip(), {"bvid": "BV1abc", "aid": 123}, object(),
                {"clipTopics": {"coordinateComments": {"enabled": True, "mode": "auto"}}},
                journal_directory=Path(directory),
            ))
            second = asyncio.run(comments.publish_coordinate_comments(
                self.clip(), {"bvid": "BV1abc", "aid": 123}, object(),
                {"clipTopics": {"coordinateComments": {"enabled": True, "mode": "auto"}}},
                journal_directory=Path(directory),
            ))
            self.assertEqual(first["items"][0]["state"], "unknown")
            self.assertEqual(second["items"][0]["state"], "unknown")
            self.assertEqual(send.call_count, 1)

    def test_interrupted_publication_is_durably_unknown_without_sending(self):
        clip = self.clip()
        suggestion = clip["commentSuggestions"][0]
        key = comments.suggestion_key("BV1abc", suggestion)
        with tempfile.TemporaryDirectory() as directory, patch.object(comments.comment, "send_comment") as send:
            journal = Path(directory) / f"{key}.json"
            journal.write_text(json.dumps({
                "schemaVersion": 1, "key": key, "bvid": "BV1abc", "aid": "123",
                "suggestion": suggestion, "state": "publishing", "startedAt": 1234,
            }), encoding="utf-8")
            for _ in range(2):
                result = asyncio.run(comments.publish_coordinate_comments(
                    clip, {"bvid": "BV1abc", "aid": 123}, object(),
                    {"clipTopics": {"coordinateComments": {"enabled": True, "mode": "auto"}}},
                    journal_directory=Path(directory),
                ))
                self.assertEqual(result["items"][0]["state"], "unknown")
                saved = json.loads(journal.read_text(encoding="utf-8"))
                self.assertEqual(saved["state"], "unknown")
                self.assertEqual(saved["startedAt"], 1234)
                self.assertIn("unknownAt", saved)
            send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
