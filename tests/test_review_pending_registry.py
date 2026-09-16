import contextlib
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.scripts import clip_upload_registry as registry
from src.scripts.clip_qa import validate_metadata_qa, validate_registry_qa
from src.scripts.clip_upload_manifest import load_upload_manifest


class ReviewPendingRegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for key, value in {"RUNTIME_DIR": self.root, "REGISTRY_PATH": self.root / "registry.json", "QUEUE_PATH": self.root / "queue.json"}.items():
            patcher = patch.object(registry, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.ready, self.ready_meta = self.metadata("ready", True)
        self.held, self.held_meta = self.metadata("held", False)
        self.manifest = self.root / "UPLOAD_MANIFEST.json"
        self.review = self.root / "REVIEW.md"
        self.review.write_text('<!-- own-stream-review:v2; machine uploads must use the JSON manifest -->', encoding="utf-8")
        self.manifest.write_text(json.dumps({"type": "bilibili_clip_upload_manifest", "reviewPath": str(self.review),
            "clips": [{"reviewIndex": 3, "metadataPath": str(self.ready)}, {"reviewIndex": 8, "metadataPath": str(self.held)}]}), encoding="utf-8")

    def metadata(self, name, ready):
        file = self.root / (name + ".json")
        output = {"metadataPath": str(file), "burnedSubtitles": True}
        for field, extension in (("mediaPath", ".mp4"), ("srtPath", ".srt"), ("coverPath", ".jpg")):
            artifact = self.root / (name + extension)
            artifact.write_bytes(b"fixture")
            output[field] = str(artifact)
        metadata = {"mode": "own_stream_fun_review", "uploadReady": ready, "publicCopyPending": not ready,
            "attributionRequired": True, "window": {"start": 1, "end": 10, "duration": 9},
            "copy": {"title": name, "description": "Description", "coverText": "Cover"}, "output": output}
        digest = hashlib.sha256("\0".join(metadata["copy"][key] for key in ("title", "coverText", "description")).encode()).hexdigest()
        metadata["attributionReview"] = {"version": 1, "status": "passed" if ready else "needs_review",
            "issues": [] if ready else ["actor_review_unavailable"], "artifactCopyDigest": digest,
            "artifactWindow": {"start": 1, "end": 10}, "artifactDigests": {"video": hashlib.sha256(b"fixture").hexdigest(), "subtitles": hashlib.sha256(b"fixture").hexdigest()}}
        file.write_text(json.dumps(metadata), encoding="utf-8")
        return file, metadata

    def invoke(self, args):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return registry.main(args)

    def records(self):
        return registry.load_json(registry.REGISTRY_PATH, {})["clips"]

    def test_strict_upload_reader_rejects_pending_but_registration_is_opt_in(self):
        with self.assertRaises(ValueError):
            load_upload_manifest(self.manifest)
        self.assertEqual(self.invoke(["import-json", "--manifest", str(self.manifest)]), 2)
        self.assertEqual(self.invoke(["import-json", "--manifest", str(self.manifest), "--include-pending"]), 0)
        held = self.records()["2"]
        self.assertEqual(held["status"], "needs_review")
        self.assertTrue(held["reviewPending"])
        self.assertIn("actor_review_unavailable", held["reviewIssues"])
        self.assertTrue(validate_registry_qa([[held]]))

    def test_existing_ids_and_uploaded_receipts_survive_full_batch_reimport(self):
        self.assertEqual(self.invoke(["import-json", "--manifest", str(self.ready)]), 0)
        saved = registry.load_json(registry.REGISTRY_PATH, {})
        saved["clips"]["1"].update(status="uploaded", uploadState={"bvid": "BV-preserved"})
        registry.save_json(registry.REGISTRY_PATH, saved)
        for _ in range(2):
            self.assertEqual(self.invoke(["import-json", "--manifest", str(self.manifest), "--include-pending"]), 0)
        self.assertEqual(set(self.records()), {"1", "2"})
        self.assertEqual(self.records()["1"]["uploadState"]["bvid"], "BV-preserved")
        self.assertEqual(self.records()["1"]["status"], "uploaded")

    def test_force_and_dry_run_cannot_enqueue_held_material(self):
        self.invoke(["import-json", "--manifest", str(self.manifest), "--include-pending"])
        for flags in ([], ["--force"], ["--dry-run"]):
            self.assertEqual(self.invoke(["enqueue", "--ids", "2", *flags]), 2)
        self.assertEqual(registry.load_json(registry.QUEUE_PATH, {}).get("jobs", []), [])

    def test_unselected_pending_metadata_does_not_block_a_ready_upload(self):
        self.assertEqual(len(load_upload_manifest(self.manifest, selected_indices=[3])), 1)
        with self.assertRaises(ValueError):
            load_upload_manifest(self.manifest, selected_indices=[8])
        self.held.write_text('not JSON', encoding="utf-8")
        self.assertEqual(load_upload_manifest(self.manifest, selected_indices=[3])[0]["reviewIndex"], 3)

    def test_review_ready_transition_keeps_the_same_id(self):
        self.invoke(["import-json", "--manifest", str(self.manifest), "--include-pending"])
        updated = {**self.held_meta, "publicCopyPending": False, "uploadReady": True}
        updated["attributionReview"]["status"] = "passed"
        self.held.write_text(json.dumps(updated), encoding="utf-8")
        self.invoke(["import-json", "--manifest", str(self.manifest), "--include-pending"])
        record = self.records()["2"]
        self.assertEqual(record["status"], "review")
        self.assertFalse(record["reviewPending"])
        self.assertEqual(validate_registry_qa([[record]]), [])

    def test_removing_a_required_gate_on_reimport_cannot_promote_a_clip(self):
        self.invoke(["import-json", "--manifest", str(self.manifest), "--include-pending"])
        updated = {**self.held_meta, "publicCopyPending": False, "uploadReady": True, "attributionRequired": False}
        self.held.write_text(json.dumps(updated), encoding="utf-8")
        self.invoke(["import-json", "--manifest", str(self.manifest), "--include-pending"])
        held = self.records()["2"]
        self.assertTrue(held["attributionRequired"])
        self.assertTrue(held["reviewPending"])

    def test_subtitles_are_readable_by_id_without_preflight_or_rewriting(self):
        self.invoke(["import-json", "--manifest", str(self.manifest), "--include-pending"])
        before = self.held.read_bytes()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(registry.main(["subtitles", "--id", "2"]), 0)
        self.assertIn("fixture", output.getvalue())
        self.assertEqual(self.held.read_bytes(), before)

    def test_generated_review_import_uses_json_indices_not_display_order(self):
        self.assertEqual(self.invoke(["import-review", "--review", str(self.review), "--source", "Source"]), 0)
        self.assertEqual([record["reviewIndex"] for record in self.records().values()], [3, 8])
        self.assertTrue(self.records()["2"]["reviewPending"])
        self.manifest.unlink()
        self.assertEqual(self.invoke(["import-review", "--review", str(self.review), "--source", "Source"]), 2)

    def test_rejected_candidate_has_an_id_but_no_upload_path(self):
        metadata = {**self.held_meta, "status": "selection_rejected", "selectionRejection": {"reason": "duration_out_of_bounds"}}
        metadata["output"]["mediaPath"] = None
        self.held.write_text(json.dumps(metadata), encoding="utf-8")
        self.assertEqual(self.invoke(["import-json", "--manifest", str(self.held), "--include-pending"]), 0)
        self.assertTrue(self.records()["1"]["reviewPending"])
        self.assertEqual(self.invoke(["enqueue", "--ids", "1"]), 2)
        self.assertEqual(self.invoke(["cut", "--ids", "1", "--review-note", "Checked"]), 2)

    def test_an_unpersisted_inline_pending_metadata_cannot_be_registered(self):
        inline = self.root / "inline.json"
        inline.write_text(json.dumps({"clips": [{"metadata": self.held_meta}]}), encoding="utf-8")
        self.assertEqual(self.invoke(["import-json", "--manifest", str(inline), "--include-pending"]), 2)

    def test_approval_without_a_note_is_not_an_available_cli_action(self):
        with self.assertRaises(SystemExit):
            self.invoke(["approve-review", "--id", "1"])

    def test_human_approval_binds_outputs_and_source_without_erasing_ai_review(self):
        metadata = self.held_meta
        source_media = self.root / "source.flv"
        source_srt = self.root / "source.srt"
        source_media.write_bytes(b"original source")
        source_srt.write_bytes(b"original subtitles")
        metadata.update(publicCopyPending=False, uploadReady=True, source={"mediaPath": str(source_media), "srtPath": str(source_srt)})
        stat = source_media.stat()
        metadata["ownStreamHumanReview"] = {"version": 1, "status": "approved", "authority": "human", "note": "Source checked", "clipId": 2,
            "artifactWindow": {"start": 1, "end": 10}, "digests": {**metadata["attributionReview"]["artifactDigests"],
                "cover": hashlib.sha256(b"fixture").hexdigest(), "copy": metadata["attributionReview"]["artifactCopyDigest"]},
            "source": {"mediaPath": str(source_media.resolve()), "mediaBytes": str(stat.st_size), "mediaMtimeNs": str(stat.st_mtime_ns),
                "srtPath": str(source_srt.resolve()), "srtSha256": hashlib.sha256(b"original subtitles").hexdigest(), "xmlPath": None, "xmlSha256": None}}
        validate_metadata_qa(metadata)
        self.assertEqual(metadata["attributionReview"]["status"], "needs_review")
        metadata["window"]["end"] = 11
        with self.assertRaises(ValueError):
            validate_metadata_qa(metadata)
        metadata["window"]["end"] = 10
        source_srt.write_bytes(b"changed source")
        with self.assertRaises(ValueError):
            validate_metadata_qa(metadata)


if __name__ == "__main__":
    unittest.main()
