import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "src" / "scripts"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from comic import screenshots


class ComicScreenshotTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="comic-screenshot-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.highlight = str(self.root / "recording_AI_HIGHLIGHT.txt")
        self.video = str(self.root / "source.mp4")

    def test_preserved_source_env_is_used_after_original_name_is_deleted(self):
        original = Path(self.video)
        original.write_bytes(b"fixture video bytes")
        alias_dir = self.root / "retained"
        alias_dir.mkdir()
        alias = alias_dir / "source.mp4"
        os.link(original, alias)
        original.unlink()
        with mock.patch.dict(os.environ, {"SOURCE_VIDEO_PATH": str(alias)}):
            self.assertEqual(screenshots.infer_source_video_path(self.highlight), str(alias))
        self.assertEqual(alias.read_bytes(), b"fixture video bytes")

    def collect(self, requests, log):
        return screenshots.generate_directed_storyboard_screenshots(
            self.highlight, json.dumps(requests), {"directedScreenshots": {"maxImages": 4}},
            source_resolver=lambda *_: self.video,
            duration_probe=lambda _: 10.0,
            log=log,
        )

    def test_failed_frame_does_not_discard_remaining_requests(self):
        calls = []
        log = mock.Mock()

        def run(args, **kwargs):
            calls.append((args, kwargs))
            if len(calls) == 1:
                return subprocess.CompletedProcess(args, 1, stdout=b"", stderr=b"bad frame")
            Path(args[-1]).write_bytes(b"jpeg")
            return subprocess.CompletedProcess(args, 0, stdout=b"", stderr=b"")

        requests = [
            {"kind": "reference", "timestampsSeconds": [2], "referenceUsage": "first"},
            {"kind": "reference", "timestampsSeconds": [20], "referenceUsage": "second"},
        ]
        with mock.patch.object(screenshots.shutil, "which", return_value="ffmpeg"), \
                mock.patch.object(screenshots.subprocess, "run", side_effect=run), \
                mock.patch.dict(os.environ, {"FFMPEG_THREADS": "3"}):
            frames = self.collect(requests, log)

        self.assertEqual([frame["referenceRequestId"] for frame in frames], ["E2"])
        self.assertEqual(frames[0]["timestampSeconds"], 20.0)
        self.assertEqual(frames[0]["selectedTimestampSeconds"], 9.9)
        self.assertTrue(any("bad frame" in str(call) for call in log.call_args_list))
        self.assertEqual(len(calls), 2)
        for args, options in calls:
            self.assertEqual(args[args.index("-threads") + 1], "3")
            self.assertEqual(options["timeout"], 120)

    def test_sheet_preserves_successful_frames_after_one_capture_times_out(self):
        from PIL import Image

        calls = []
        log = mock.Mock()

        def run(args, **kwargs):
            calls.append(args)
            if len(calls) == 1:
                raise subprocess.TimeoutExpired(args, kwargs["timeout"])
            Image.new("RGB", (640, 360), (40, 160, 90)).save(args[-1], "JPEG")
            return subprocess.CompletedProcess(args, 0, stdout=b"", stderr=b"")

        with mock.patch.object(screenshots.shutil, "which", return_value="ffmpeg"), \
                mock.patch.object(screenshots.subprocess, "run", side_effect=run):
            frames = self.collect([{
                "kind": "reference", "timestampsSeconds": [2, 20],
                "referenceUsage": "sequence", "captureMode": "sheet",
            }], log)

        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]["candidateCount"], 1)
        self.assertEqual(frames[0]["timestampsSeconds"], [9.9])
        self.assertEqual(frames[0]["selectionMode"], "script_requested_sheet")
        with Image.open(frames[0]["path"]) as image:
            self.assertGreater(image.getpixel((100, 100))[1], 100)
        log.assert_called_once()

    def test_disabled_capture_does_not_resolve_or_run_media_tools(self):
        resolve = mock.Mock(side_effect=AssertionError("unexpected source lookup"))
        with mock.patch.object(screenshots.subprocess, "run") as run:
            frames = screenshots.generate_directed_storyboard_screenshots(
                self.highlight, "{}", {"directedScreenshots": {"enabled": False}},
                source_resolver=resolve,
            )
        self.assertEqual(frames, [])
        resolve.assert_not_called()
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
