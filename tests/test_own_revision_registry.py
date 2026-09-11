import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.scripts import clip_upload_registry as api
from src.scripts.clip_qa import validate_metadata_qa


def digest(value):
    return hashlib.sha256(value).hexdigest()


class OwnRevisionRegistryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for key, value in {"RUNTIME_DIR": self.root, "REGISTRY_PATH": self.root / "registry.json",
                           "QUEUE_PATH": self.root / "queue.json"}.items():
            patcher = patch.object(api, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.file = self.root / "clip.json"
        source = {"mediaPath": str(self.root / "source.flv"), "srtPath": str(self.root / "source.srt")}
        Path(source["mediaPath"]).write_bytes(b"source recording")
        Path(source["srtPath"]).write_text("1\n00:00:01,000 --> 00:01:01,000\nHello world\n", encoding="utf-8")
        output = {"mediaPath": str(self.root / "old.mp4"), "srtPath": str(self.root / "old.srt"),
                  "coverPath": str(self.root / "old.jpg"), "metadataPath": str(self.file), "burnedSubtitles": True}
        Path(output["mediaPath"]).write_bytes(b"old video")
        Path(output["srtPath"]).write_text("1\n00:00:00,000 --> 00:01:00,000\nHello world\n", encoding="utf-8")
        Path(output["coverPath"]).write_bytes(b"old cover")
        source_hash = digest(json.dumps([{"index": 0, "start": 1, "end": 61, "text": "Hello world", "speaker": ""}],
                                       separators=(",", ":")).encode())
        metadata = {"mode": "own_stream_fun_review", "source": source, "output": output, "reviewIndex": 3,
                    "window": {"index": 3, "start": 1, "end": 61, "duration": 60},
                    "copy": {"title": '"Hello world"', "description": "Hello world", "coverText": "Hello world"},
                    "grounding": {"sourceSha256": source_hash, "sourceKind": "live_speech"},
                    "upload": {"prefix": "[Host]", "source": "Host stream", "tags": ["Host"], "tid": 21},
                    "streamerName": "Host", "roomId": "1", "recordedAt": "2026-09-09", "streamTitle": "Stream"}
        self.approve_fixture(metadata)
        self.write_metadata(metadata)
        self.assertEqual(self.command(["import-json", "--manifest", str(self.file), "--review", str(self.root / "REVIEW.md")]), 0)

    def command(self, args):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return api.main(args)

    def metadata(self):
        return json.loads(self.file.read_text(encoding="utf-8"))

    def write_metadata(self, metadata):
        self.file.write_text(json.dumps(metadata), encoding="utf-8")

    def records(self):
        return api.load_json(api.REGISTRY_PATH, {})["clips"]

    def queue(self):
        return api.load_json(api.QUEUE_PATH, {}).get("jobs", [])

    def approve_fixture(self, metadata):
        source, output, copy = metadata["source"], metadata["output"], metadata["copy"]
        stat = Path(source["mediaPath"]).stat()
        metadata["ownStreamHumanReview"] = {"version": 1, "status": "approved", "authority": "human", "clipId": 1,
            "note": "Source checked", "sourceKind": "live_speech",
            "artifactWindow": {key: metadata["window"][key] for key in ("start", "end")},
            "source": {"mediaPath": source["mediaPath"], "mediaBytes": str(stat.st_size), "mediaMtimeNs": str(stat.st_mtime_ns),
                       "srtPath": source["srtPath"], "srtSha256": digest(Path(source["srtPath"]).read_bytes()),
                       "xmlPath": None, "xmlSha256": None},
            "digests": {"video": digest(Path(output["mediaPath"]).read_bytes()), "subtitles": digest(Path(output["srtPath"]).read_bytes()),
                        "cover": digest(Path(output["coverPath"]).read_bytes()),
                        "copy": digest("\0".join(copy[key] for key in ("title", "coverText", "description")).encode())}}
        metadata["uploadReady"] = True

    def correct(self, enqueue=False):
        return self.command(["correct", "--id", "1", "--from", "world", "--to", "friend", "--cue", "1",
                             "--note", "User checked this correction", *(["--enqueue"] if enqueue else [])])

    def publish_fixture(self):
        registry = api.load_json(api.REGISTRY_PATH, {})
        registry["clips"]["1"].update(status="uploaded", uploadState={"bvid": "BV_existing"})
        api.save_json(api.REGISTRY_PATH, registry)

    def worker(self, render, upload):
        def guard(queue, registry, **kwargs):
            state = api.ensure_account_upload_guard(queue, "test")
            api.recalculate_account_upload_guard(state)
            return state, True
        with patch.object(api, "cut_candidates", side_effect=render), patch.object(api, "run_batch", side_effect=upload), patch.object(
                api, "refresh_account_upload_guard", side_effect=guard), patch.object(api, "configured_upload_account", return_value=("test", "", "")), contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(api.run_one_job())

    def test_correct_and_enqueue_records_own_revision_without_rendering_and_deduplicates(self):
        with patch.object(api, "cut_candidates") as render:
            self.assertEqual(self.correct(enqueue=True), 0)
            self.assertEqual(self.correct(enqueue=True), 0)
            render.assert_not_called()
        self.assertEqual(list(self.records()), ["1"])
        clip = self.records()["1"]
        self.assertEqual(clip["status"], "queued")
        self.assertTrue(clip["pendingRebuild"])
        self.assertEqual(clip["mediaPath"], str(self.root / "old.mp4"))
        self.assertEqual(self.queue()[0]["candidateSubtitles"]["1"]["kind"], "own_stream")
        self.assertEqual(len(self.queue()), 1)

    def test_missing_match_does_not_mutate_or_enqueue(self):
        before = self.file.read_bytes()
        self.assertEqual(self.command(["correct", "--id", "1", "--from", "absent", "--to", "friend", "--enqueue"]), 2)
        self.assertEqual(self.file.read_bytes(), before)
        self.assertEqual(self.queue(), [])

    def test_subtitles_shows_current_revision_and_dry_run_never_approves(self):
        self.assertEqual(self.correct(), 0)
        before = self.file.read_bytes()
        self.assertEqual(self.command(["subtitles", "--id", "1"]), 0)
        self.assertEqual(self.command(["enqueue", "--ids", "1", "--dry-run"]), 0)
        self.assertEqual(self.file.read_bytes(), before)
        self.assertIsNone(self.metadata()["renderedSubtitles"].get("approval"))
        self.assertEqual(self.queue(), [])

    def test_review_refresh_preserves_pending_rebuild_and_the_same_id(self):
        self.assertEqual(self.correct(), 0)
        self.assertEqual(self.command(["import-json", "--manifest", str(self.file), "--include-pending"]), 0)
        self.assertEqual(list(self.records()), ["1"])
        self.assertEqual(self.records()["1"]["status"], "pending_rebuild")
        self.assertTrue(self.records()["1"]["pendingRebuild"])
        self.assertEqual(self.records()["1"]["candidateRevision"], 1)

    def test_worker_owned_revisions_cannot_be_corrected_or_reprepared(self):
        self.assertEqual(self.correct(enqueue=True), 0)
        before = self.file.read_bytes()
        self.assertEqual(self.command(["correct", "--id", "1", "--from", "friend", "--to", "world"]), 2)
        self.assertEqual(self.command(["rebuild", "--id", "1", "--review-note", "Checked"]), 2)
        self.assertEqual(self.file.read_bytes(), before)

    def test_published_ids_allow_local_drafts_but_never_duplicate_enqueue_even_force(self):
        self.publish_fixture()
        before = self.file.read_bytes()
        self.assertEqual(self.correct(enqueue=True), 2)
        self.assertEqual(self.file.read_bytes(), before)
        self.assertEqual(self.correct(), 0)
        self.assertEqual(self.records()["1"]["uploadState"]["bvid"], "BV_existing")
        self.assertEqual(self.command(["enqueue", "--ids", "1", "--force"]), 2)
        self.assertEqual(self.queue(), [])

    def test_pending_revision_cannot_pass_metadata_qa_by_reusing_old_approval(self):
        self.assertEqual(self.correct(), 0)
        metadata = self.metadata()
        with self.assertRaisesRegex(ValueError, "needs rendering"):
            validate_metadata_qa(metadata)
        metadata["rebuildRequired"] = False
        metadata["renderedSubtitles"].update(renderedSha256=metadata["renderedSubtitles"]["sha256"], renderedRevision=1)
        with self.assertRaisesRegex(ValueError, "differ from"):
            validate_metadata_qa(metadata)

    def test_rebuild_explicitly_repairs_copy_and_returns_before_render(self):
        before_media = Path(self.metadata()["output"]["mediaPath"]).read_bytes()
        self.assertEqual(self.command(["rebuild", "--id", "1", "--review-note", "Checked source", "--source-kind", "live_speech",
                                       "--title", "A conversation", "--description", "The host greets viewers", "--cover-text", "Hello"]), 0)
        self.assertTrue(self.records()["1"]["pendingRebuild"])
        self.assertEqual(Path(self.metadata()["output"]["mediaPath"]).read_bytes(), before_media)
        self.assertEqual(self.queue(), [])

    def test_published_topic_rebuild_and_cut_preserve_the_id_source_and_online_state(self):
        metadata = self.metadata()
        metadata.update(mode="local_review", status="success", uploadId=1)
        metadata["window"]["index"] = "E1-1"
        metadata["aiReview"] = {"status": "ready", "window": {"start": 1, "end": 61},
                                "sourceSha256": metadata.pop("grounding")["sourceSha256"]}
        del metadata["ownStreamHumanReview"]
        self.write_metadata(metadata)
        self.publish_fixture()
        original_record = self.records()["1"]
        original_video = Path(metadata["output"]["mediaPath"]).read_bytes()
        xml = self.root / "source.xml"
        xml.write_text('<i><d p="30,1,25,16777215,0,0,0,0">Hello audience</d></i>', encoding="utf-8")
        self.assertEqual(self.command(["rebuild", "--id", "1", "--start", "0", "--end", "61", "--xml", str(xml),
                                       "--review-note", "Checked full context", "--source-kind", "live_speech",
                                       "--title", "A full conversation", "--description", "The host greets viewers",
                                       "--cover-text", "Hello"]), 0)
        self.assertEqual(self.metadata()["aiReview"], metadata["aiReview"])
        self.assertTrue(self.records()["1"]["pendingRebuild"])
        self.assertEqual(self.records()["1"]["status"], "uploaded")
        self.assertEqual(self.command(["enqueue", "--ids", "1", "--force"]), 2)
        self.assertEqual(self.command(["rebuild", "--id", "1", "--review-note", "Checked", "--enqueue"]), 2)

        def render(_api, clip, action, options, **kwargs):
            self.assertEqual(action, "render")
            self.assertEqual(clip["id"], 1)
            current = self.metadata()
            draft = current["renderedSubtitles"]
            current["output"].update(mediaPath=str(self.root / "revised.mp4"), srtPath=draft["path"])
            Path(current["output"]["mediaPath"]).write_bytes(b"revised video")
            current.update(rebuildRequired=False, publicCopyPending=False)
            draft.update(renderedSha256=draft["sha256"], renderedRevision=draft["revision"])
            self.approve_fixture(current)
            # The explicit XML attachment is part of the human source snapshot.
            current["ownStreamHumanReview"]["source"] = draft["sourceSnapshot"]
            self.write_metadata(current)
            return {}

        with patch.object(api.clip_candidate_queue, "candidate_action", side_effect=render), patch.object(api, "run_batch") as upload:
            self.assertEqual(self.command(["cut", "--ids", "1", "--review-note", "Checked full context"]), 0)
            upload.assert_not_called()
        record = self.records()["1"]
        self.assertEqual(list(self.records()), ["1"])
        for key in ("id", "reviewIndex", "source", "prefix", "tags", "statePath", "status", "uploadState"):
            self.assertEqual(record[key], original_record[key], key)
        self.assertFalse(record["pendingRebuild"])
        self.assertEqual(record["metadataPath"], str(self.file))
        self.assertEqual(record["mediaPath"], str(self.root / "revised.mp4"))
        self.assertEqual(record["title"], "A full conversation")
        self.assertEqual(self.metadata()["mode"], "local_review")
        self.assertEqual(self.metadata()["aiReview"], metadata["aiReview"])
        self.assertEqual(Path(metadata["output"]["mediaPath"]).read_bytes(), original_video)
        self.assertEqual(self.queue(), [])

    def test_failed_render_never_uploads_and_retains_correctable_revision(self):
        self.assertEqual(self.correct(enqueue=True), 0)
        upload = unittest.mock.Mock()
        self.worker(lambda args: 2, upload)
        upload.assert_not_called()
        self.assertEqual(self.queue()[0]["status"], "failed")
        self.assertTrue(self.records()["1"]["pendingRebuild"])
        self.assertEqual(self.command(["correct", "--id", "1", "--from", "friend", "--to", "friendship"]), 0)

    def test_worker_rebuilds_before_upload_and_keeps_id_source_identity_and_state_file(self):
        self.assertEqual(self.correct(enqueue=True), 0)
        original = self.records()["1"]
        timeline = []

        def render(args):
            timeline.append("render")
            self.assertTrue(args.require_approval)
            self.assertEqual(self.records()["1"]["status"], "rendering")
            metadata = self.metadata()
            draft = metadata["renderedSubtitles"]
            metadata["output"]["mediaPath"] = str(self.root / "revised.mp4")
            Path(metadata["output"]["mediaPath"]).write_bytes(b"new video")
            metadata["output"]["srtPath"] = draft["path"]
            draft.update(renderedSha256=draft["sha256"], renderedRevision=draft["revision"])
            metadata["rebuildRequired"] = False
            self.approve_fixture(metadata)
            self.write_metadata(metadata)
            return self.command(["import-json", "--manifest", str(self.file), "--review", original["reviewPath"], "--state", original["statePath"]])

        def upload(group, job):
            timeline.append("upload")
            clip = group[0]
            self.assertEqual(clip["id"], 1)
            self.assertEqual(clip["reviewIndex"], 3)
            self.assertEqual(clip["statePath"], original["statePath"])
            self.assertFalse(clip["pendingRebuild"])
            Path(clip["statePath"]).write_text(json.dumps({"done": {"3": {"title": api.full_title(clip),
                "mediaPath": clip["mediaPath"], "bvid": "BV_offline_test"}}}), encoding="utf-8")
            return subprocess.CompletedProcess([], 0, "uploaded", "")

        self.worker(render, upload)
        self.assertEqual(timeline, ["render", "upload"])
        self.assertEqual(list(self.records()), ["1"])
        self.assertEqual(self.records()["1"]["status"], "uploaded")
        self.assertEqual(self.queue()[0]["status"], "done")

    def test_recovered_long_clip_still_requires_matching_duration_approval(self):
        metadata = self.metadata()
        metadata["originalSelectionRejection"] = {"reason": "duration_out_of_bounds", "maxClipSeconds": 30}
        with self.assertRaisesRegex(ValueError, "duration approval"):
            validate_metadata_qa(metadata)
        metadata["durationApproval"] = {"authority": "user", "note": "Complete interaction", "start": 1, "end": 61}
        validate_metadata_qa(metadata)
        metadata["durationApproval"]["end"] = 60
        with self.assertRaisesRegex(ValueError, "does not match"):
            validate_metadata_qa(metadata)

    @unittest.skipUnless(os.environ.get("DANMAKU_TEST_REAL_MEDIA") == "1", "opt-in FFmpeg/GPU integration test")
    def test_real_source_render_and_media_audit_without_upload(self):
        metadata = self.metadata()
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
                        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "62",
                        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-f", "flv", metadata["source"]["mediaPath"]],
                       check=True, capture_output=True, timeout=120)
        self.approve_fixture(metadata)
        self.write_metadata(metadata)
        self.assertEqual(self.correct(), 0)
        with patch.object(api, "run_batch") as upload:
            self.assertEqual(self.command(["cut", "--ids", "1", "--review-note", "Synthetic media and exact corrected subtitle test"]), 0)
            upload.assert_not_called()
        saved = self.metadata()
        validate_metadata_qa(saved)
        self.assertEqual(file_hash := digest(Path(saved["output"]["srtPath"]).read_bytes()), saved["renderedSubtitles"]["sha256"])
        self.assertEqual(self.records()["1"]["id"], 1)
        self.assertEqual(self.queue(), [])
        output_directory = os.environ.get("DANMAKU_MEDIA_TEST_OUTPUT")
        if output_directory:
            destination = Path(output_directory).resolve()
            destination.mkdir(parents=True, exist_ok=True)
            for key in ("mediaPath", "srtPath", "coverPath"):
                source = Path(saved["output"][key])
                shutil.copy2(source, destination / source.name)
            (destination / "result.json").write_text(json.dumps({"status": "passed", "subtitleSha256": file_hash,
                "uploadCalled": False, "output": saved["output"]}, indent=2), encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
