import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.scripts import clip_upload_registry as registry


class TopicCandidateRegistryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name, value in {
            "RUNTIME_DIR": self.root,
            "REGISTRY_PATH": self.root / "registry.json",
            "QUEUE_PATH": self.root / "queue.json",
        }.items():
            patcher = patch.object(registry, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def candidate(self, name="candidate"):
        file = self.root / f"{name}.json"
        metadata = {
            "status": "pending_preflight", "uploadReady": False,
            "window": {"index": "E1-1", "start": 10, "end": 50},
            "copy": {"title": "Candidate", "description": "Source-backed description"},
            "upload": {"prefix": "[Host]", "source": "Host stream", "tags": ["Host"]},
            "output": {"mediaPath": None, "metadataPath": str(file)},
        }
        file.write_text(json.dumps(metadata), encoding="utf-8")
        return file, metadata

    def import_file(self, file):
        return registry.main(["import-json", "--manifest", str(file)])

    def records(self):
        return registry.load_json(registry.REGISTRY_PATH, {})["clips"]

    def test_preview_retains_id_status_and_never_approves_or_enqueues(self):
        file, metadata = self.candidate()
        self.assertEqual(self.import_file(file), 0)
        result = self.subtitle_result(metadata)
        result['reviewPreview'] = {'status': 'ready', 'mediaPath': str(self.root / 'preview.mp4'),
                                   'srtPath': str(self.root / 'preview.srt')}
        with patch.object(registry.clip_candidate_queue, 'candidate_action', return_value=result) as action, patch.object(registry, 'enqueue') as enqueue:
            self.assertEqual(registry.main(['preview', '--ids', '1']), 0)
        self.assertEqual(action.call_args.args[2], 'preview')
        enqueue.assert_not_called()
        saved = self.records()['1']
        self.assertEqual(saved['status'], 'pending_cut')
        self.assertTrue(saved['pendingCut'])
        self.assertFalse(saved['mediaPath'])
        self.assertEqual(saved['reviewPreview'], result['reviewPreview'])
        self.assertFalse(registry.QUEUE_PATH.exists())

    def test_preview_skips_active_uploads_and_continues_after_failure(self):
        for name in ('first', 'second'):
            file, metadata = self.candidate(name)
            self.assertEqual(self.import_file(file), 0)
        registry.save_json(registry.QUEUE_PATH, {'jobs': [{'status': 'running', 'clipIds': [1]}]})
        with patch.object(registry.clip_candidate_queue, 'candidate_action', side_effect=ValueError('missing video')) as action:
            self.assertEqual(registry.main(['preview', '--ids', '1,2']), 2)
        self.assertEqual(action.call_count, 1)
        self.assertEqual(action.call_args.args[1]['id'], 2)

    def test_reserves_distinct_global_ids_and_reuses_them_on_reimport(self):
        first, _ = self.candidate("first")
        second, _ = self.candidate("second")
        for file in (first, second, first):
            self.assertEqual(self.import_file(file), 0)
        records = self.records()
        self.assertEqual(list(records), ["1", "2"])
        self.assertEqual(records["1"]["candidateIndex"], "E1-1")
        self.assertTrue(records["1"]["pendingCut"])
        self.assertEqual(records["1"]["status"], "pending_cut")

    def test_same_review_row_and_empty_media_do_not_collapse_different_candidates(self):
        first, _ = self.candidate("first")
        second, _ = self.candidate("second")
        for file in (first, second):
            self.assertEqual(registry.main(["import-json", "--manifest", str(file),
                                            "--review", str(self.root / "REVIEW.md")]), 0)
        self.assertEqual(len(self.records()), 2)

    def test_render_promotes_same_id_and_stale_pending_import_cannot_erase_media(self):
        file, metadata = self.candidate()
        registry.main(["import-json", "--manifest", str(file), "--review", str(self.root / "original_REVIEW.md")])
        pending = json.loads(json.dumps(metadata))
        metadata["status"] = "success"
        metadata["output"]["mediaPath"] = str(self.root / "clip.mp4")
        file.write_text(json.dumps(metadata), encoding="utf-8")
        self.import_file(file)
        rendered = self.records()["1"]
        self.assertEqual(rendered["status"], "review")
        self.assertFalse(rendered["pendingCut"])
        self.assertEqual(rendered["candidateReviewPath"], str(self.root / "original_REVIEW.md"))
        file.write_text(json.dumps(pending), encoding="utf-8")
        self.import_file(file)
        self.assertEqual(self.records()["1"]["mediaPath"], rendered["mediaPath"])
        self.assertEqual(self.records()["1"]["status"], "review")

    def test_failed_subtitle_approval_cannot_enqueue_even_with_force(self):
        file, _ = self.candidate()
        self.import_file(file)
        with patch.object(registry, "cut_candidates") as cut, patch.object(
            registry.clip_candidate_queue, "candidate_action", side_effect=ValueError("draft changed")
        ):
            for flags in ([], ["--force"]):
                self.assertEqual(registry.main(["enqueue", "--ids", "1", *flags]), 2)
            cut.assert_not_called()
        self.assertEqual(registry.load_json(registry.QUEUE_PATH, {}).get("jobs", []), [])
        self.assertTrue(any("needs cutting" in error for error in registry.validate_groups([[self.records()["1"]]])))

    def test_enqueue_dry_run_does_not_render_or_upload_candidates(self):
        file, _ = self.candidate()
        self.import_file(file)
        with patch.object(registry, "cut_candidates") as cut:
            self.assertEqual(registry.main(["enqueue", "--ids", "1", "--dry-run"]), 0)
            cut.assert_not_called()
        self.assertFalse(registry.QUEUE_PATH.exists())

    def test_one_upload_command_only_approves_and_queues_same_ids_without_rendering(self):
        file, metadata = self.candidate()
        self.import_file(file)
        ready_file, ready = self.candidate("ready")
        ready["status"] = "success"
        ready["output"]["mediaPath"] = str(self.root / "ready.mp4")
        ready_file.write_text(json.dumps(ready), encoding="utf-8")
        self.import_file(ready_file)

        def approve(api, clip, action, options, **kwargs):
            self.assertEqual(clip["id"], 1)
            self.assertEqual(action, "approve")
            return self.subtitle_result(metadata)

        with patch.object(registry.clip_candidate_queue, "candidate_action", side_effect=approve) as action, patch.object(
            registry, "cut_candidates"
        ) as cut:
            self.assertEqual(registry.main(["enqueue", "--ids", "1,2"]), 0)
            self.assertEqual(registry.main(["enqueue", "--ids", "1,2"]), 0)
            action.assert_called_once()
            cut.assert_not_called()
        job = registry.load_json(registry.QUEUE_PATH, {})["jobs"][0]
        self.assertEqual(job["clipIds"], [1, 2])
        self.assertEqual(job["candidateSubtitles"]["1"]["sha256"], "saved-subtitle-hash")
        self.assertTrue(self.records()["1"]["pendingCut"])
        self.assertEqual(self.records()["1"]["status"], "queued")
        self.assertEqual(self.records()["2"]["status"], "queued")

    def test_cut_uses_id_keeps_upload_identity_and_never_enqueues(self):
        file, metadata = self.candidate()
        self.import_file(file)

        def rendered(command, **_kwargs):
            self.assertIn(str(file), command)
            self.assertIn("--candidate-id", command)
            self.assertIn("--description", command)
            metadata["status"] = "success"
            metadata["output"]["mediaPath"] = str(self.root / "clip.mp4")
            file.write_text(json.dumps(metadata), encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, "rendered", "")

        with patch.object(registry.subprocess, "run", side_effect=rendered) as run:
            self.assertEqual(registry.main(["cut", "--ids", "1", "--description", "New copy",
                                            "--review-note", "Source checked"]), 0)
            self.assertEqual(registry.main(["cut", "--ids", "1", "--review-note", "Retry"]), 0)
            self.assertEqual(run.call_count, 1)
        self.assertFalse(registry.QUEUE_PATH.exists())
        self.assertEqual(self.records()["1"]["status"], "review")
        self.assertEqual(self.records()["1"]["prefix"], "[Host]")
        self.assertEqual(self.records()["1"]["statePath"], str(file.with_name("candidate_upload_state.json")))

    def test_failed_cut_stays_pending_and_unknown_ids_do_not_spawn(self):
        file, _ = self.candidate()
        self.import_file(file)
        with patch.object(registry.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "blocked")) as run:
            self.assertEqual(registry.main(["cut", "--ids", "999", "--review-note", "Checked"]), 2)
            run.assert_not_called()
            self.assertEqual(registry.main(["cut", "--ids", "1", "--review-note", "Checked"]), 2)
        self.assertEqual(self.records()["1"]["status"], "pending_cut")

    def subtitle_result(self, metadata):
        return {"candidateSrtPath": str(self.root / "candidate_r0001.srt"), "candidateRevision": 1,
                "candidateSrtSha256": "saved-subtitle-hash", "copy": metadata["copy"], "cues": []}

    def test_correct_and_enqueue_saves_literal_request_and_returns_before_rendering(self):
        file, metadata = self.candidate()
        self.import_file(file)
        calls = []

        def action(api, clip, action, options, **kwargs):
            calls.append(action)
            if action == "correct":
                self.assertEqual(options["from"], "zzz")
                self.assertEqual(options["to"], "睡睡睡")
            return self.subtitle_result(metadata)

        args = ["correct", "--id", "1", "--from", "zzz", "--to", "睡睡睡", "--enqueue"]
        with patch.object(registry.clip_candidate_queue, "candidate_action", side_effect=action), patch.object(registry, "cut_candidates") as cut:
            self.assertEqual(registry.main(args), 0)
            self.assertEqual(registry.main(args), 0)
            cut.assert_not_called()
        self.assertEqual(calls, ["correct", "approve"])
        self.assertEqual(self.records()["1"]["lastCandidateCorrection"], {"from": "zzz", "to": "睡睡睡", "cue": None})
        self.assertEqual(len(registry.load_json(registry.QUEUE_PATH, {})["jobs"]), 1)

    def test_unmatched_correction_never_queues_or_changes_registry(self):
        file, _ = self.candidate()
        self.import_file(file)
        with patch.object(registry.clip_candidate_queue, "candidate_action", side_effect=ValueError("No literal subtitle match")):
            self.assertEqual(registry.main(["correct", "--id", "1", "--from", "absent", "--to", "word", "--enqueue"]), 2)
        self.assertFalse(registry.QUEUE_PATH.exists())
        self.assertEqual(self.records()["1"]["status"], "pending_cut")

    def run_worker(self, render, upload):
        def guard(queue, data, now=None, force_remote=False):
            state = registry.ensure_account_upload_guard(queue, "test")
            registry.recalculate_account_upload_guard(state, now)
            return state, True

        with patch.object(registry, "cut_candidates", side_effect=render), patch.object(registry, "run_batch", side_effect=upload), patch.object(
            registry, "refresh_account_upload_guard", side_effect=guard
        ), patch.object(registry, "configured_upload_account", return_value=("test", "", "")):
            self.assertTrue(registry.run_one_job())

    def test_worker_renders_before_upload_and_preserves_concurrently_queued_work(self):
        file, metadata = self.candidate()
        self.import_file(file)
        with patch.object(registry.clip_candidate_queue, "candidate_action", return_value=self.subtitle_result(metadata)):
            registry.main(["enqueue", "--ids", "1"])
        timeline = []

        def render(args):
            timeline.append("render")
            self.assertTrue(args.require_approval)
            self.assertEqual(args.candidate_subtitles["1"]["sha256"], "saved-subtitle-hash")
            self.assertEqual(self.records()["1"]["status"], "rendering")
            other_file, other = self.candidate("other")
            other["status"] = "success"
            other["output"]["mediaPath"] = str(self.root / "other.mp4")
            other_file.write_text(json.dumps(other), encoding="utf-8")
            self.import_file(other_file)
            registry.main(["enqueue", "--ids", "2"])
            metadata["status"] = "success"
            metadata["output"]["mediaPath"] = str(self.root / "candidate.mp4")
            file.write_text(json.dumps(metadata), encoding="utf-8")
            return self.import_file(file)

        def upload(group, job):
            timeline.append("upload")
            self.assertFalse(group[0]["pendingCut"])
            clip = group[0]
            Path(clip["statePath"]).write_text(json.dumps({"done": {str(clip["reviewIndex"]): {
                "title": registry.full_title(clip), "mediaPath": clip["mediaPath"], "bvid": "BV_OFFLINE_TEST"}}}), encoding="utf-8")
            return subprocess.CompletedProcess([], 0, "uploaded", "")

        self.run_worker(render, upload)
        self.assertEqual(timeline, ["render", "upload"])
        self.assertEqual(self.records()["1"]["status"], "uploaded")
        self.assertEqual(self.records()["2"]["status"], "queued")
        self.assertEqual([job["status"] for job in registry.load_json(registry.QUEUE_PATH, {})["jobs"]], ["done", "pending"])

    def test_failed_worker_render_does_not_upload_and_keeps_candidate_correctable(self):
        file, metadata = self.candidate()
        self.import_file(file)
        with patch.object(registry.clip_candidate_queue, "candidate_action", return_value=self.subtitle_result(metadata)):
            registry.main(["enqueue", "--ids", "1"])
        upload = unittest.mock.Mock()
        self.run_worker(lambda args: 2, upload)
        upload.assert_not_called()
        self.assertTrue(self.records()["1"]["pendingCut"])
        self.assertEqual(self.records()["1"]["status"], "failed")
        self.assertEqual(registry.load_json(registry.QUEUE_PATH, {})["jobs"][0]["status"], "failed")

    def mixed_render_job(self):
        files = []
        for name in ("blocked", "renderable", "ready"):
            file, metadata = self.candidate(name)
            if name == "ready":
                metadata["status"] = "success"
                metadata["output"]["mediaPath"] = str(self.root / "ready.mp4")
                file.write_text(json.dumps(metadata), encoding="utf-8")
            registry.main(["import-json", "--manifest", str(file), "--state", str(self.root / f"{name}_state.json")])
            files.append((file, metadata))
        with patch.object(registry.clip_candidate_queue, "candidate_action", return_value=self.subtitle_result(files[0][1])):
            self.assertEqual(registry.main(["enqueue", "--ids", "1,2,3"]), 0)
        return files

    def test_worker_isolates_failed_render_and_uploads_remaining_candidates_and_ready_media(self):
        files = self.mixed_render_job()
        rendered, uploaded = [], []

        def render(args):
            rendered.append(args.ids)
            if args.ids == "1":
                data = registry.load_json(registry.REGISTRY_PATH, {})
                data["clips"]["1"]["candidateError"] = "unsupported date"
                registry.save_json(registry.REGISTRY_PATH, data)
                return 2
            self.assertEqual(args.ids, "2")
            file, metadata = files[1]
            metadata["status"] = "success"
            metadata["output"]["mediaPath"] = str(self.root / "renderable.mp4")
            file.write_text(json.dumps(metadata), encoding="utf-8")
            return registry.main(["import-json", "--manifest", str(file), "--state", str(self.root / "renderable_state.json")])

        def upload(group, job):
            for clip in group:
                uploaded.append(clip["id"])
                Path(clip["statePath"]).write_text(json.dumps({"done": {str(clip["reviewIndex"]): {
                    "title": registry.full_title(clip), "mediaPath": clip["mediaPath"], "bvid": "BV_OFFLINE_TEST"}}}), encoding="utf-8")
            return subprocess.CompletedProcess([], 0, "uploaded", "")

        self.run_worker(render, upload)
        self.assertEqual(rendered, ["1", "2"])
        self.assertCountEqual(uploaded, [2, 3])
        self.assertEqual([self.records()[str(i)]["status"] for i in (1, 2, 3)], ["failed", "uploaded", "uploaded"])
        self.assertEqual(self.records()["1"]["failureReason"], "unsupported date")
        job = registry.load_json(registry.QUEUE_PATH, {})["jobs"][0]
        self.assertEqual(job["status"], "failed")
        self.assertEqual(job["renderFailures"], {"1": "unsupported date"})
        self.assertNotIn("retryAt", job)

    def test_render_failure_survives_upload_retry_and_worker_recovery(self):
        self.mixed_render_job()
        # Both candidates fail; the already-rendered clip has a transient upload error.
        self.run_worker(lambda args: 2, lambda group, job: subprocess.CompletedProcess([], 1, "network timeout", ""))
        queue = registry.load_json(registry.QUEUE_PATH, {})
        self.assertEqual(queue["jobs"][0]["status"], "retry_wait")
        self.assertEqual([self.records()[str(i)]["status"] for i in (1, 2)], ["failed", "failed"])
        queue["jobs"][0].update(status="running", phase="uploading")
        registry.save_json(registry.QUEUE_PATH, queue)
        self.assertTrue(registry.recover_interrupted_jobs())
        self.assertEqual([self.records()[str(i)]["status"] for i in (1, 2, 3)], ["failed", "failed", "queued"])
        queue = registry.load_json(registry.QUEUE_PATH, {})
        queue["jobs"][0].pop("retryAt", None)
        registry.save_json(registry.QUEUE_PATH, queue)
        render = unittest.mock.Mock()

        def upload(group, job):
            self.assertEqual([clip["id"] for clip in group], [3])
            clip = group[0]
            Path(clip["statePath"]).write_text(json.dumps({"done": {str(clip["reviewIndex"]): {
                "title": registry.full_title(clip), "mediaPath": clip["mediaPath"], "bvid": "BV_OFFLINE_TEST"}}}), encoding="utf-8")
            return subprocess.CompletedProcess([], 0, "uploaded", "")

        self.run_worker(render, upload)
        render.assert_not_called()
        self.assertEqual(self.records()["3"]["status"], "uploaded")
        self.assertEqual(registry.load_json(registry.QUEUE_PATH, {})["jobs"][0]["status"], "failed")

    def test_interrupted_render_job_recovers_with_the_same_approved_revision(self):
        file, metadata = self.candidate()
        self.import_file(file)
        with patch.object(registry.clip_candidate_queue, "candidate_action", return_value=self.subtitle_result(metadata)):
            registry.main(["enqueue", "--ids", "1"])
        queue = registry.load_json(registry.QUEUE_PATH, {})
        queue["jobs"][0].update(status="running", phase="rendering")
        registry.save_json(registry.QUEUE_PATH, queue)
        data = registry.load_json(registry.REGISTRY_PATH, {})
        data["clips"]["1"]["status"] = "rendering"
        registry.save_json(registry.REGISTRY_PATH, data)
        self.assertTrue(registry.recover_interrupted_jobs())
        recovered = registry.load_json(registry.QUEUE_PATH, {})["jobs"][0]
        self.assertEqual(recovered["status"], "pending")
        self.assertEqual(recovered["candidateSubtitles"]["1"]["sha256"], "saved-subtitle-hash")
        self.assertEqual(self.records()["1"]["status"], "queued")

    def test_different_correction_cannot_change_a_worker_owned_revision(self):
        file, metadata = self.candidate()
        self.import_file(file)
        with patch.object(registry.clip_candidate_queue, "candidate_action", return_value=self.subtitle_result(metadata)) as action:
            registry.main(["enqueue", "--ids", "1"])
            action.reset_mock()
            self.assertEqual(registry.main(["correct", "--id", "1", "--from", "zzz", "--to", "changed", "--enqueue"]), 2)
            action.assert_not_called()
        self.assertEqual(self.records()["1"]["candidateSrtSha256"], "saved-subtitle-hash")


if __name__ == "__main__":
    unittest.main()
