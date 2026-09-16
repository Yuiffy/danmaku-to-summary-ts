import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.scripts import audit_bilibili_clip as audit


class BilibiliClipAuditTests(unittest.TestCase):
    def write_srt(self, root, content):
        path = root / "clip.srt"
        path.write_text(content, encoding="utf-8")
        return path

    def media_probe(self, duration=10.0):
        return {
            "duration": duration,
            "streams": [
                {"codec_type": "video", "codec_name": "h264"},
                {"codec_type": "audio", "codec_name": "aac"},
            ],
        }

    def test_checks_srt_bounds_and_required_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "clip.mp4"
            video.write_bytes(b"placeholder")
            srt = self.write_srt(
                root,
                (
                    "1\n00:00:00,500 --> 00:00:02,000\n"
                    "小岁谈到 5070Ti\n\n"
                    "2\n00:00:03,000 --> 00:00:04,500\n"
                    "随后遇见梅琳娜\n"
                ),
            )

            with patch.object(audit, "probe_media", return_value=self.media_probe()):
                report = audit.audit_local_clip(
                    video,
                    srt_path=srt,
                    evidence=["5070 Ti|5070Ti", "梅琳娜"],
                )

            self.assertEqual(report["errors"], [])
            self.assertEqual(report["local"]["subtitleFirst"], 0.5)
            self.assertEqual(report["local"]["subtitleLast"], 4.5)

    def test_reports_missing_evidence_and_subtitles_outside_media(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "clip.mp4"
            video.write_bytes(b"placeholder")
            srt = self.write_srt(
                root,
                "1\n00:00:09,000 --> 00:00:12,000\n只提到其他内容\n",
            )

            with patch.object(audit, "probe_media", return_value=self.media_probe()):
                report = audit.audit_local_clip(
                    video,
                    srt_path=srt,
                    evidence=["5070Ti"],
                )

            self.assertEqual(report["status"], "error")
            self.assertTrue(any("beyond media duration" in item for item in report["errors"]))
            self.assertTrue(any("required evidence" in item for item in report["errors"]))

    def test_accepts_generated_metadata_srt_segment_count_and_cover(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "clip.mp4"
            cover = root / "clip_cover.jpg"
            metadata = root / "clip.json"
            video.write_bytes(b"placeholder")
            cover.write_bytes(b"placeholder")
            srt = self.write_srt(
                root,
                (
                    "1\n00:00:00,000 --> 00:00:02,000\n片段开始\n\n"
                    "2\n00:00:03,000 --> 00:00:05,000\n片段结束\n"
                ),
            )
            metadata.write_text(
                json.dumps(
                    {
                        "window": {"duration": 5},
                        "copy": {"title": "正确标题", "description": "片中内容"},
                        "output": {
                            "mediaPath": str(video),
                            "burnedSubtitles": True,
                            "srtSegmentCount": 2,
                            "coverPath": str(cover),
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            with patch.object(audit, "probe_media", return_value=self.media_probe(5.0)), patch.object(
                audit, "_cover_dimensions", return_value=(1920, 1080)
            ):
                report = audit.audit_local_clip(
                    video,
                    srt_path=srt,
                    metadata_path=metadata,
                )

            self.assertEqual(report["errors"], [])
            self.assertEqual(report["checks"]["metadataSubtitleSegmentCount"], 2)
            self.assertEqual(report["checks"]["coverDimensions"], [1920, 1080])

    def test_reports_metadata_media_path_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "actual.mp4"
            other_video = root / "other.mp4"
            metadata = root / "actual.json"
            video.write_bytes(b"placeholder")
            other_video.write_bytes(b"placeholder")
            metadata.write_text(
                json.dumps(
                    {
                        "copy": {"title": "标题"},
                        "output": {
                            "mediaPath": str(other_video),
                            "burnedSubtitles": True,
                        },
                    }
                ),
                encoding="utf-8",
            )

            with patch.object(audit, "probe_media", return_value=self.media_probe()):
                report = audit.audit_local_clip(video, metadata_path=metadata)

            self.assertTrue(any("mediaPath does not match" in item for item in report["errors"]))

    def test_reports_online_title_and_duration_mismatch(self):
        report = audit.compare_online_archive(
            {
                "archive": {"bvid": "BV1TEST", "title": "线上标题", "state": 0},
                "videos": [{"duration": 22.0, "cid": 123}],
            },
            expected_title="本地标题",
            local_duration=10.0,
        )

        self.assertEqual(report["status"], "error")
        self.assertTrue(any("online title mismatch" in item for item in report["errors"]))
        self.assertTrue(any("online duration mismatch" in item for item in report["errors"]))


if __name__ == "__main__":
    unittest.main()
