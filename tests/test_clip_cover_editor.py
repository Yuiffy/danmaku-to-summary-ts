import argparse
import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from src.scripts import clip_upload_registry as api
from src.scripts import clip_cover_editor as editor
from src.scripts.cover_generator import CoverGenerator
from src.scripts.cover_selection import media_identity, selected_cover, validate_selection
from src.scripts.clip_qa import validate_metadata_qa


class CoverSelectionTests(unittest.TestCase):
    def test_rejects_nonfinite_and_outside_crops(self):
        selection = {"time": 1.2, "part": 1, "text": "测试封面"}
        for extra in ({"time": float("nan")}, {"time": True}, {"part": 0}, {"text": ""},
                      {"crop": {"x": .9, "y": 0, "width": .2, "height": .5}},
                      {"crop": {"x": 0, "y": 0, "width": 0, "height": 1}}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                validate_selection({**selection, **extra})

    def test_crops_the_requested_frame_before_lettering_and_cleans_temporary_frame(self):
        class Generator:
            def extract_frame(self, video, time, output):
                self.time = time
                image = Image.new("RGB", (400, 200), "red")
                image.paste("blue", (200, 0, 400, 200))
                image.save(output)

            def add_text_to_cover(self, frame, text, **kwargs):
                self.frame = Path(frame)
                with Image.open(frame) as image:
                    self.size, self.pixel = image.size, image.getpixel((100, 100))
                self.text = text
                return kwargs["output_path"]

        generator = Generator()
        with patch("src.scripts.cover_selection.subprocess.run", return_value=subprocess.CompletedProcess([], 0, '{"format":{"duration":"10"}}')):
            selected_cover(generator, "video.mp4", {"time": 4.25, "part": 1, "text": "重新压字",
                           "crop": {"x": .5, "y": 0, "width": .5, "height": 1}}, "cover.jpg")
            self.assertEqual(generator.time, 4.25)
            self.assertEqual(generator.size, (200, 200))
            self.assertGreater(generator.pixel[2], 240)
            self.assertEqual(generator.text, "重新压字")
            self.assertFalse(generator.frame.exists())
            with self.assertRaisesRegex(ValueError, "outside"):
                selected_cover(generator, "video.mp4", {"time": 10, "text": "测试", "part": 1}, "out.jpg")

    def test_relettering_reuses_selection_only_for_the_same_media(self):
        with tempfile.TemporaryDirectory() as directory:
            video = Path(directory) / "video.mp4"
            video.write_bytes(b"video")
            selection = {"time": 2, "part": 1, "text": "旧文字", "mediaIdentity": media_identity(video)}
            generator = CoverGenerator()
            with patch("src.scripts.cover_selection.selected_cover", return_value="manual.jpg") as render:
                self.assertEqual(generator.generate_cover(str(video), "新文字", manual_selection=selection), "manual.jpg")
                self.assertEqual(render.call_args.args[2]["time"], 2)
                self.assertEqual(render.call_args.args[2]["text"], "新文字")
            video.write_bytes(b"changed-video")
            with patch.object(generator, "select_best_frame", return_value=("auto.jpg", 1)), patch.object(generator, "add_text_to_cover", return_value="auto-cover.jpg"), patch("src.scripts.cover_selection.selected_cover") as render:
                self.assertEqual(generator.generate_cover(str(video), "新文字", manual_selection=selection), "auto-cover.jpg")
                render.assert_not_called()


class ClipCoverEditorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.media = self.root / "clip.mp4"
        self.media.write_bytes(b"video")
        self.metadata = self.root / "clip.json"
        self.original = {"mode": "own_stream_fun_review", "uploadReady": True, "copy": {"coverText": "旧封面"},
                         "output": {"mediaPath": str(self.media), "coverPath": "old.jpg"},
                         "ownStreamHumanReview": {"status": "approved", "note": "之前核对过"}}
        self.metadata.write_text(json.dumps(self.original), encoding="utf-8")
        self.registry = self.root / "registry.json"
        self.queue = self.root / "queue.json"
        self.record = {"id": 1, "status": "review", "metadataPath": str(self.metadata), "mediaPath": str(self.media)}
        self.registry.write_text(json.dumps({"clips": {"1": self.record}}), encoding="utf-8")
        self.queue.write_text('{"jobs":[]}', encoding="utf-8")
        self.patches = [patch.object(api, "REGISTRY_PATH", self.registry), patch.object(api, "QUEUE_PATH", self.queue), patch.object(api, "RUNTIME_DIR", self.root)]
        for item in self.patches:
            item.start()
        self.args = argparse.Namespace(id=1, note="确认这个画面", selection=json.dumps({"time": 1.25, "part": 1, "text": "新封面"}))

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.directory.cleanup()

    def render(self, generator, media, selection, output):
        Image.new("RGB", (960, 540), "blue").save(output)

    def test_saves_new_cover_under_same_id_without_touching_queue_or_video(self):
        queue_before = self.queue.read_bytes()
        with patch.object(editor, "selected_cover", side_effect=self.render):
            self.assertEqual(editor.edit_cover(self.args, api), 0)
        metadata = json.loads(self.metadata.read_text(encoding="utf-8"))
        record = json.loads(self.registry.read_text())["clips"]["1"]
        self.assertEqual(metadata["coverSelection"]["time"], 1.25)
        self.assertEqual(metadata["copy"]["coverText"], "新封面")
        self.assertTrue(Path(record["coverPath"]).is_file())
        self.assertTrue(record["reviewPending"])
        self.assertEqual(record["status"], "needs_review")
        self.assertEqual(metadata["ownStreamHumanReview"]["status"], "needs_review")
        with self.assertRaisesRegex(ValueError, "fresh final review"):
            validate_metadata_qa(metadata)
        self.assertEqual(self.queue.read_bytes(), queue_before)
        self.assertEqual(self.media.read_bytes(), b"video")

    def test_refuses_queued_ids_and_detects_upload_started_during_rendering(self):
        def race(*args):
            self.render(*args)
            self.queue.write_text('{"jobs":[{"status":"pending","clipIds":[1]}]}')
        with patch.object(editor, "selected_cover", side_effect=race):
            self.assertEqual(editor.edit_cover(self.args, api), 2)
        self.assertEqual(json.loads(self.metadata.read_text()), self.original)
        self.assertEqual(list((self.root / "cover_revisions").glob("*.jpg")), [])
        with patch.object(editor, "selected_cover") as render:
            self.assertEqual(editor.edit_cover(self.args, api), 2)
            render.assert_not_called()

    def test_failure_and_concurrent_metadata_edits_do_not_replace_the_existing_cover(self):
        with patch.object(editor, "selected_cover", side_effect=RuntimeError("failed decode")):
            self.assertEqual(editor.edit_cover(self.args, api), 2)
        def race(*args):
            self.render(*args)
            self.metadata.write_text('{"userEdit":true}')
        with patch.object(editor, "selected_cover", side_effect=race):
            self.assertEqual(editor.edit_cover(self.args, api), 2)
        self.assertEqual(json.loads(self.metadata.read_text()), {"userEdit": True})
        self.assertNotIn("coverPath", json.loads(self.registry.read_text())["clips"]["1"])
        self.assertEqual(list((self.root / "cover_revisions").glob("*.jpg")), [])

    def test_selects_a_bundle_part_and_rebinds_cover_hash_for_dedicated_review(self):
        part2 = self.root / "part2.mp4"
        part2.write_bytes(b"part-two")
        self.original.update(type="stream_activity_submission", coverSha256="old", activityReview={"status": "approved"})
        self.original["output"]["parts"] = [{"mediaPath": str(self.media)}, {"mediaPath": str(part2)}]
        self.metadata.write_text(json.dumps(self.original))
        self.args.selection = json.dumps({"time": 1, "part": 2, "text": "第二 P 画面"})
        with patch.object(editor, "selected_cover", side_effect=self.render) as render:
            self.assertEqual(editor.edit_cover(self.args, api), 0)
            self.assertEqual(render.call_args.args[1], str(part2))
        saved = json.loads(self.metadata.read_text(encoding="utf-8"))
        self.assertEqual(saved["activityReview"]["status"], "needs_review")
        self.assertEqual(saved["coverSha256"], hashlib.sha256(Path(saved["output"]["coverPath"]).read_bytes()).hexdigest())

    def test_command_parser_exposes_the_numeric_id_cover_recipe(self):
        args = api.build_parser().parse_args(["cover", "--id", "1", "--selection", self.args.selection, "--note", "确认"])
        self.assertEqual(args.id, 1)
        self.assertEqual(args.selection, self.args.selection)


if __name__ == "__main__":
    unittest.main()
