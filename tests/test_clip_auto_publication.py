import argparse
import copy
import datetime as dt
import hashlib
import io
import json
import subprocess
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from src.scripts import clip_auto_publication as publication
from src.scripts import clip_automatic_retry as automatic_retry
from src.scripts import clip_upload_registry as registry
from src.scripts.clip_qa import validate_metadata_qa, validate_registry_qa
from src.scripts.clip_upload_manifest import load_upload_manifest


class AutomaticPublicationTests(unittest.TestCase):
    def test_campaign_policy_is_separate_and_keeps_queued_in_period_artifacts_valid(self):
        policy = {"mode": "auto", "roomIds": ["event"], "policyVersion": "own-stream-v1",
                  "activatedAt": "2026-10-23T09:00:00Z", "authorizationNote": "explicit campaign authority"}
        config = {"ownStreamClips": {"automaticPublication": {"mode": "off"}, "campaigns": [{
            "enabled": True, "roomIds": ["event"], "startsAt": "2026-10-22T00:00:00+08:00",
            "endsAt": "2026-11-06T00:00:00+08:00", "settings": {"automaticPublication": policy}}]}}
        metadata = {"mode": "own_stream_fun_review", "roomId": "event", "recordedAt": "2026-10-23 14:02:55", "generatedAt": "2026-10-23T09:30:00Z"}
        self.assertEqual(publication.validate_policy(metadata, config), policy)
        self.assertEqual(publication.validate_policy({**metadata, "generatedAt": "2026-11-06T00:00:00+08:00"}, config), policy)
        for changes in ({"roomId": "other"}, {"recordedAt": "2026-10-21 14:02:55"},
                        {"recordedAt": "2026-11-06 00:00:00"}, {"generatedAt": "2026-10-23T08:59:59Z"},
                        {"recordedAt": ""}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                publication.validate_policy({**metadata, **changes}, config)
        config["ownStreamClips"]["campaigns"][0]["enabled"] = False
        with self.assertRaises(ValueError):
            publication.validate_policy(metadata, config)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        self.registry_path = self.runtime / "registry.json"
        self.queue_path = self.runtime / "queue.json"
        self.policy = {"mode": "auto", "roomIds": ["25788785"], "policyVersion": "own-stream-v1",
                       "activatedAt": "2026-10-03T00:00:00Z", "authorizationNote": "User authorized enablement"}
        self.config = {"ownStreamClips": {"automaticPublication": self.policy}}
        self.metadata = self.make_metadata("one")
        self.write_metadata()
        self.record = {**load_upload_manifest(self.metadata_path)[0], "id": 1, "status": "review",
                       "statePath": str(self.root / "upload-state.json")}
        self.data = {"version": 1, "nextClipId": 2, "clips": {"1": self.record}, "batches": {}}
        registry.save_json(self.registry_path, self.data)
        for name, value in (("RUNTIME_DIR", self.runtime), ("REGISTRY_PATH", self.registry_path),
                            ("QUEUE_PATH", self.queue_path)):
            patcher = patch.object(registry, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(registry, "load_upload_runtime_config", return_value=self.config)
        patcher.start()
        self.addCleanup(patcher.stop)

    def make_metadata(self, name):
        files = {}
        for field in ("mediaPath", "srtPath", "coverPath"):
            path = self.root / f"{name}-{field}"
            path.write_text(field, encoding="utf-8")
            files[field] = str(path)
        source = {}
        for field in ("mediaPath", "srtPath"):
            path = self.root / f"source-{field}"
            if not path.exists():
                path.write_text(field, encoding="utf-8")
            source[field] = str(path)
        metadata = {"mode": "own_stream_fun_review", "roomId": "25788785", "generatedAt": "2026-10-03T01:00:00Z",
                    "automaticPublicationRequired": True, "uploadReady": True,
                    "window": {"start": 10, "end": 20, "duration": 10}, "source": source,
                    "copy": {"title": "Title", "coverText": "Cover", "description": "Description"},
                    "output": {**files, "burnedSubtitles": True},
                    "upload": {"source": "Source", "prefix": "Prefix", "tags": ["tag"], "tid": 21}}
        metadata["publicationReview"] = {"version": 1, "policyVersion": "own-stream-v1", "status": "passed",
            "issues": [], "checks": {key: True for key in publication.CHECKS}, "technical": {"passed": True, "issues": []},
            "roomId": "25788785", "reviewedAt": "2026-10-03T01:01:00Z",
            "artifactWindow": copy.deepcopy(metadata["window"]), "source": publication.source_snapshot(metadata),
            "digests": {"video": publication.file_digest(files["mediaPath"]), "cover": publication.file_digest(files["coverPath"]),
                        "subtitles": publication.file_digest(files["srtPath"]),
                        "copy": hashlib.sha256(b"Title\0Cover\0Description").hexdigest()}}
        metadata["publicationDecision"] = {"version": 1, "policyVersion": "own-stream-v1", "action": "auto_queue", "reasons": []}
        return metadata

    def write_metadata(self):
        self.metadata_path = self.root / "clip.json"
        self.metadata_path.write_text(json.dumps(self.metadata), encoding="utf-8")

    def test_front_loaded_timeline_and_every_composing_asset_remain_bound_at_worker_gate(self):
        files = []
        for name in ('metadata', 'media', 'subtitles', 'opManifest', 'opMedia', 'opSubtitles'):
            file = self.root / f'editorial-{name}'
            file.write_text(name, encoding='utf-8')
            files.append(str(file))
        keys = ('metadata', 'media', 'subtitles', 'opManifest', 'opMedia', 'opSubtitles')
        hashes = [publication.file_digest(file) for file in files]
        timeline = {'version': 1, 'baseline': dict(zip(keys[:3], files[:3])),
                    **dict(zip(keys[3:], files[3:])), 'binding': dict(zip(keys, hashes)),
                    'pieces': [{'kind': 'op', 'outputStart': 3, 'start': 0, 'end': 6}]}
        self.metadata['style'] = 'highlight_first'
        self.metadata['editorialTimeline'] = timeline
        self.metadata['publicationReview']['editorialTimeline'] = copy.deepcopy(timeline)
        self.metadata['publicationReview']['digests']['editorial'] = hashlib.sha256('\0'.join(hashes).encode()).hexdigest()
        publication.validate_publication_review(self.metadata)
        timeline['pieces'][0]['outputStart'] = 2
        with self.assertRaisesRegex(ValueError, 'timeline changed'):
            publication.validate_publication_review(self.metadata)
        timeline['pieces'][0]['outputStart'] = 3
        for file in files:
            original = Path(file).read_bytes()
            Path(file).write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'composing source changed'):
                publication.validate_publication_review(self.metadata)
            Path(file).write_bytes(original)

    def enqueue(self, ids="1", **kwargs):
        args = argparse.Namespace(ids=ids, automatic=True, force=False, dry_run=False, **kwargs)
        output = io.StringIO()
        with redirect_stdout(output):
            result = registry.enqueue(args)
        self.assertEqual(result, 0, output.getvalue())
        payload = output.getvalue().split("AUTOMATIC_ENQUEUE_RESULT: ", 1)[1]
        return json.loads(payload)

    def saved(self):
        return registry.load_json(self.registry_path, {}), registry.load_json(self.queue_path, {})

    def test_worker_cannot_read_a_new_job_with_a_registry_snapshot_from_before_enqueue(self):
        read_json = registry.load_json
        entered, finished = threading.Event(), threading.Event()
        results, errors = [], []

        def enqueue_while_reading():
            entered.set()
            try:
                results.append(self.enqueue())
            except Exception as error:
                errors.append(error)
            finally:
                finished.set()

        writer = threading.Thread(target=enqueue_while_reading)
        started = False

        def read_at_enqueue_boundary(path, default):
            nonlocal started
            value = read_json(path, default)
            if path == self.registry_path and not started and threading.current_thread() is threading.main_thread():
                started = True
                writer.start()
                self.assertTrue(entered.wait(2))
                finished.wait(0.1)
            return value

        def guard(queue, _registry, **_kwargs):
            return registry.ensure_account_upload_guard(queue, "test-account"), False

        try:
            with patch.object(registry, "load_json", side_effect=read_at_enqueue_boundary), \
                    patch.object(registry, "refresh_account_upload_guard", side_effect=guard), \
                    patch.object(registry, "run_batch") as uploader:
                self.assertFalse(registry.run_one_job())
                uploader.assert_not_called()
        finally:
            writer.join(5)
        self.assertFalse(writer.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(results[0]["queuedIds"], [1])
        saved, queue = self.saved()
        self.assertEqual(saved["clips"]["1"]["automaticPublicationAuthorization"],
            queue["jobs"][0]["automaticPublicationAuthorizations"]["1"])

    def test_worker_progress_preserves_another_automatic_authorization_enqueued_after_its_snapshot(self):
        metadata = self.make_metadata("two")
        metadata["window"] = {"start": 40, "end": 50, "duration": 10}
        metadata["publicationReview"]["artifactWindow"] = copy.deepcopy(metadata["window"])
        path = self.root / "second.json"
        path.write_text(json.dumps(metadata), encoding="utf-8")
        self.data["clips"]["2"] = {**load_upload_manifest(path)[0], "id": 2, "status": "review",
            "statePath": str(self.root / "second-state.json")}
        self.data["nextClipId"] = 3
        registry.save_json(self.registry_path, self.data)
        self.enqueue()

        def before_status_commit(_api, snapshot, queue, _job, _ids):
            self.assertEqual(self.enqueue("2")["queuedIds"], [2])
            return snapshot, queue

        def uploaded(_group, _job):
            state = {"done": {"1": {"title": "PrefixTitle", "bvid": "BVfirst", "mediaPath": self.record["mediaPath"]}}}
            registry.save_json(Path(self.record["statePath"]), state)
            return subprocess.CompletedProcess([], 0, stdout="uploaded")

        def guard(queue, _registry, **_kwargs):
            return registry.ensure_account_upload_guard(queue, "test-account"), False

        with patch.object(registry.clip_candidate_queue, "render_for_job", side_effect=before_status_commit), \
                patch.object(registry, "refresh_account_upload_guard", side_effect=guard), \
                patch.object(registry, "configured_upload_account", return_value=("test-account", "", "")), \
                patch.object(registry, "run_batch", side_effect=uploaded), redirect_stdout(io.StringIO()):
            self.assertTrue(registry.run_one_job())
        saved, queue = self.saved()
        self.assertEqual(saved["clips"]["1"]["status"], "uploaded")
        self.assertEqual(saved["clips"]["2"]["status"], "queued")
        self.assertEqual(saved["clips"]["2"]["automaticPublicationAuthorization"],
            queue["jobs"][1]["automaticPublicationAuthorizations"]["2"])
        self.assertEqual(queue["jobs"][1]["status"], "pending")
        self.assertEqual(saved["nextClipId"], 3)

    def test_known_bad_timing_blocks_enqueue_and_saved_worker_authorization(self):
        receipt = self.enqueue()
        self.assertEqual(receipt['queuedIds'], [1])
        saved, queue = self.saved()
        source = Path(self.metadata['source']['srtPath'])
        source.with_suffix('.asr_meta.json').write_text(json.dumps({'backend': 'paraformer',
            'speakerProcessing': {'intervalSource': 'sentence_info_fallback'}}), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '时间轴不可靠'):
            publication.validate_publication_review(self.metadata)
        errors = publication.validate_job_authorizations([[saved['clips']['1']]], queue['jobs'][0], lambda: self.config)
        self.assertTrue(any('时间轴不可靠' in error for error in errors))

    def test_renaming_source_to_aligned_does_not_approve_the_old_burned_timing_revision(self):
        aligned = self.root / 'ALIGNED.srt'
        aligned.write_text('corrected timeline', encoding='utf-8')
        self.metadata['source']['srtPath'] = str(aligned)
        self.metadata['renderedTimingRepair'] = {'version': 1, 'transcript': {'path': str(aligned)}}
        with self.assertRaisesRegex(ValueError, '尚未重建'):
            publication.validate_publication_review(self.metadata)

    def use_topic(self):
        self.policy = {"mode": "auto", "scope": "configured_keywords", "policyVersion": "topic-v1",
                       "activatedAt": "2026-10-03T00:00:00Z", "authorizationNote": "User authorized topic publication"}
        self.config.clear()
        self.config.update({"clipTopics": {"enabled": True, "keywords": ["小岁", "SUI"],
                            "ignoredRoomIds": ["25788785"], "automaticPublication": self.policy}})
        self.metadata.update(mode="local_review", publicationKind="keyword_topic", roomId="other-host", status="success")
        self.metadata["source"]["sourceKind"] = "video"
        self.metadata["aiReview"] = {"version": 1, "mode": "preflight", "status": "ready", "applied": True,
            "sourceSha256": "e" * 64, "window": {"start": 10, "end": 20},
            "quality": {"status": "pass", "issues": []}, "keyword": {"status": "confirmed", "hits": [
                {"id": "K1", "cueId": "G1", "start": 11, "end": 12, "keywords": ["小岁"], "verdict": "mention",
                 "evidenceCueIds": ["G1"], "text": "小岁说", "reason": "Confirmed in source"}]},
            "boundaryReview": {"status": "linked", "unresolvedCueIds": []}}
        self.metadata["editorial"] = {"status": "planned", "copyStatus": "prepared", "sourceKind": "recount",
            "copyWindow": {"start": 10, "end": 20}, "copyGrounding": {"version": 1, "status": "linked", "issues": [],
                "sourceKind": "recount", "sourceSha256": "e" * 64}}
        self.metadata["publicationReview"].update(policyVersion="topic-v1", roomId="other-host",
            topicEvidence={key: copy.deepcopy(self.metadata[key]) for key in ("publicationKind", "aiReview", "editorial")})
        self.metadata["publicationDecision"]["policyVersion"] = "topic-v1"
        self.write_metadata()
        self.record = {**load_upload_manifest(self.metadata_path)[0], "id": 1, "status": "review",
                       "statePath": str(self.root / "upload-state.json")}
        self.data["clips"] = {"1": self.record}
        registry.save_json(self.registry_path, self.data)

    def test_pass_queues_once_with_policy_authority_and_no_fake_human_review(self):
        self.assertEqual(self.enqueue()["queuedIds"], [1])
        saved, queue = self.saved()
        clip = saved["clips"]["1"]
        self.assertEqual(clip["automaticPublicationAuthorization"]["authority"], "configured_policy")
        self.assertNotIn("ownStreamHumanReview", self.metadata)
        self.assertEqual(publication.validate_job_authorizations([[clip]], queue["jobs"][0], lambda: self.config), [])
        self.assertEqual(self.enqueue()["results"], [{"id": 1, "status": "already_queued"}])
        self.assertEqual(len(self.saved()[1]["jobs"]), 1)

    def test_uncertain_unknown_and_excluded_ids_do_not_block_good_clip(self):
        self.data["clips"]["2"] = {**self.record, "id": 2, "reviewPending": True}
        self.data["clips"]["3"] = {**self.record, "id": 3, "publicationIdentity": "another-source-window",
                                   "editorialExclusion": {"reason": "User excluded"}}
        registry.save_json(self.registry_path, self.data)
        result = self.enqueue("2,1,3,99")
        self.assertEqual(result["queuedIds"], [1])
        self.assertEqual([row["status"] for row in result["results"]], ["needs_human", "queued", "needs_human", "needs_human"])

    def test_old_artifacts_wrong_room_and_disabled_policy_never_queue(self):
        for change in ({"mode": "off"}, {"roomIds": ["other"]}, {"activatedAt": "2026-10-04T00:00:00Z"}):
            with self.subTest(change=change):
                original = self.policy.copy()
                self.policy.update(change)
                self.assertEqual(self.enqueue()["queuedIds"], [])
                self.policy.clear()
                self.policy.update(original)

    def test_missing_required_checks_bad_window_or_source_and_unburned_subtitles_are_blocked(self):
        original = copy.deepcopy(self.metadata)
        mutations = [lambda m: m["publicationReview"]["checks"].pop("subtitles"),
                     lambda m: m["publicationReview"].update(status="needs_review"),
                     lambda m: m["publicationReview"]["technical"].update(passed=False),
                     lambda m: m["window"].update(end=25),
                     lambda m: m["publicationReview"]["source"].update(mediaBytes="100000"),
                     lambda m: m["output"].update(burnedSubtitles=False),
                     lambda m: m["publicationDecision"].update(action="needs_human"),
                     lambda m: m.update(generatedAt="yesterday")]
        for mutate in mutations:
            self.metadata = copy.deepcopy(original)
            mutate(self.metadata)
            with self.assertRaises((ValueError, KeyError)):
                validate_metadata_qa(self.metadata)

    def test_changed_video_cover_subtitles_copy_and_source_invalidate_review(self):
        for field in ("mediaPath", "coverPath", "srtPath"):
            path = Path(self.metadata["output"][field])
            original = path.read_bytes()
            path.write_bytes(b"modified")
            with self.assertRaisesRegex(ValueError, "artifacts changed"):
                publication.validate_publication_review(self.metadata)
            path.write_bytes(original)
        self.metadata["copy"]["title"] = "Different actor"
        with self.assertRaisesRegex(ValueError, "artifacts changed"):
            publication.validate_publication_review(self.metadata)
        self.metadata["copy"]["title"] = "Title"
        Path(self.metadata["source"]["srtPath"]).write_text("changed source", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "source changed"):
            publication.validate_publication_review(self.metadata)

    def test_precision_edit_binds_final_duration_without_confusing_it_with_source_span(self):
        self.metadata["window"]["duration"] = 7
        self.metadata["publicationReview"]["artifactWindow"]["duration"] = 7
        self.metadata["publicationReview"]["technical"]["facts"] = {"duration": 7.08, "expectedDuration": 7}
        publication.validate_publication_review(self.metadata)
        self.metadata["publicationReview"]["technical"]["facts"]["duration"] = 10
        with self.assertRaisesRegex(ValueError, "technical review duration"):
            publication.validate_publication_review(self.metadata)

    def test_final_pass_cannot_erase_no_clip_intent(self):
        self.metadata["clipIntent"] = {"version": 1, "needsHumanReview": True}
        with self.assertRaisesRegex(ValueError, "别切意图.*人工核对"):
            publication.validate_publication_review(self.metadata)

    def test_final_pass_cannot_erase_unresolved_source_or_audio_review(self):
        for key, value in (("preRenderHold", True), ("sourceExpansionRequest", {"reason": "ending"}),
                           ("storyRepairRequest", {"reason": "story"}),
                           ("creativeResult", {"history": [{"stage": "source_window_incomplete"}]}),
                           ("subtitleProofreading", {"reviewGroups": [{"word": "uncertain"}]})):
            with self.subTest(key=key):
                self.metadata[key] = value
                with self.assertRaises(ValueError):
                    publication.validate_publication_review(self.metadata)
                self.metadata.pop(key)
        self.metadata["audioQa"] = {"status": "passed", "listeningReview": "pending_human_review"}
        with self.assertRaisesRegex(ValueError, "listening review"):
            publication.validate_publication_review(self.metadata)
        self.metadata.pop("audioQa")
        self.metadata["grounding"] = {"status": "needs_review", "issues": ["uncertain_source"]}
        with self.assertRaisesRegex(ValueError, "uncertain source"):
            publication.validate_publication_review(self.metadata)
        self.metadata["attributionReview"] = {"status": "passed", "claims": [{"sourceKind": "recount", "cueIds": ["s1"]}]}
        self.metadata["publicationReview"]["resolvedGroundingIssues"] = [
            {"issue": "uncertain_source", "reason": "Evidence confirms this is a retelling", "claimIndexes": [0]}]
        publication.validate_publication_review(self.metadata)
        self.metadata["attributionReview"]["claims"][0]["cueIds"] = []
        with self.assertRaisesRegex(ValueError, "no source evidence"):
            publication.validate_publication_review(self.metadata)

    def test_dry_run_does_not_create_queue_or_save_authorization(self):
        before = self.registry_path.read_bytes()
        args = registry.build_parser().parse_args(["enqueue", "--ids", "1", "--automatic", "--dry-run"])
        with redirect_stdout(io.StringIO()):
            self.assertEqual(registry.enqueue(args), 0)
        self.assertFalse(self.queue_path.exists())
        self.assertEqual(self.registry_path.read_bytes(), before)

    def test_asr_evidence_appearance_change_and_removal_invalidate_review(self):
        evidence = Path(self.metadata["source"]["srtPath"]).with_suffix(".asr_evidence.json")
        evidence.write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "source changed"):
            publication.validate_publication_review(self.metadata)
        self.metadata["publicationReview"]["source"] = publication.source_snapshot(self.metadata)
        publication.validate_publication_review(self.metadata)
        evidence.write_text('{"changed": true}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "source changed"):
            publication.validate_publication_review(self.metadata)
        evidence.unlink()
        with self.assertRaisesRegex(ValueError, "source changed"):
            publication.validate_publication_review(self.metadata)

    def test_worker_rechecks_policy_and_both_authorization_copies(self):
        self.enqueue()
        saved, queue = self.saved()
        clip, job = saved["clips"]["1"], queue["jobs"][0]
        self.policy["mode"] = "off"
        self.assertTrue(publication.validate_job_authorizations([[clip]], job, lambda: self.config))
        self.policy["mode"] = "auto"
        original = copy.deepcopy(clip)
        for field in ("automaticPublicationAuthorization", "automaticPublicationRequired", "metadataPath"):
            clip = copy.deepcopy(original)
            clip.pop(field)
            self.assertTrue(publication.validate_job_authorizations([[clip]], job, lambda: self.config))
        clip = copy.deepcopy(original)
        job.pop("automaticPublicationAuthorizations")
        self.assertTrue(publication.validate_job_authorizations([[clip]], job, lambda: self.config))

    def test_each_upload_subprocess_rechecks_automatic_policy_after_queue_wait(self):
        self.enqueue()
        saved, queue = self.saved()
        self.policy["mode"] = "off"
        with patch.object(registry.subprocess, "run") as uploader:
            result = registry.run_batch([saved["clips"]["1"]], queue["jobs"][0])
        self.assertEqual(result.returncode, 2)
        self.assertIn("automatic publication authorization invalid", result.stdout)
        uploader.assert_not_called()

    def test_later_batch_member_rechecks_live_authorization_at_actual_submit(self):
        self.enqueue()
        saved, queue = self.saved()
        queue["jobs"][0]["status"] = "running"
        registry.save_json(self.queue_path, queue)
        upload_clip = load_upload_manifest(self.metadata_path)[0]
        publication.validate_submission_authorization(upload_clip, queue["jobs"][0]["id"], registry)
        self.policy["mode"] = "off"
        with self.assertRaisesRegex(ValueError, "authorization invalid"):
            publication.validate_submission_authorization(upload_clip, queue["jobs"][0]["id"], registry)
        self.policy["mode"] = "auto"
        queue["jobs"][0]["status"] = "cancelled"
        registry.save_json(self.queue_path, queue)
        with self.assertRaisesRegex(ValueError, "no longer running"):
            publication.validate_submission_authorization(upload_clip, queue["jobs"][0]["id"], registry)

    def test_removed_flag_metadata_and_registry_copy_drift_cannot_bypass_worker(self):
        self.enqueue()
        saved, queue = self.saved()
        clip = saved["clips"]["1"]
        clip["title"] = "Changed"
        self.assertTrue(validate_registry_qa([[clip]]))
        self.metadata.pop("automaticPublicationRequired")
        self.write_metadata()
        self.assertTrue(validate_registry_qa([[clip]]))
        self.assertTrue(publication.validate_job_authorizations([[clip]], queue["jobs"][0], lambda: self.config))
        self.metadata_path.unlink()
        self.assertTrue(validate_registry_qa([[clip]]))

    def test_same_source_window_with_different_output_path_cannot_republish(self):
        self.data["clips"]["2"] = {**self.record, "id": 2, "status": "uploaded",
                                   "publicationIdentity": publication.publication_identity(self.metadata)}
        self.data["clips"]["2"]["metadataPath"] = str(self.root / "moved-away.json")
        registry.save_json(self.registry_path, self.data)
        self.assertEqual(self.enqueue()["results"], [{"id": 1, "status": "duplicate", "duplicateOf": 2}])
        self.assertEqual(self.enqueue("2")["results"], [{"id": 2, "status": "already_uploaded"}])

    def test_source_identity_ignores_source_path_changes(self):
        identity = publication.publication_identity(self.metadata)
        original = Path(self.metadata["source"]["mediaPath"])
        renamed = original.with_name("source-renamed")
        original.rename(renamed)
        self.metadata["source"]["mediaPath"] = str(renamed)
        self.assertEqual(publication.publication_identity(self.metadata), identity)
        self.metadata["copy"]["title"] = "New title"
        Path(self.metadata["source"]["srtPath"]).write_text("Corrected subtitles", encoding="utf-8")
        self.assertEqual(publication.publication_identity(self.metadata), identity)

    def test_shifted_window_cannot_automatically_republish_under_a_new_identity(self):
        self.data['clips']['2'] = {**self.record, 'id': 2, 'status': 'uploaded',
            'start': 9, 'duration': 11, 'metadataPath': '', 'publicationIdentity': 'older-window',
            'mediaPath': str(self.root / 'older-render.mp4'), 'uploadState': {'bvid': 'BVOLD'}}
        registry.save_json(self.registry_path, self.data)
        result = self.enqueue()
        self.assertEqual(result['queuedIds'], [])
        self.assertEqual(result['results'][0]['status'], 'needs_human')
        self.assertIn('duplicate source content', result['results'][0]['error'])

    def test_two_new_automatic_clips_cannot_reserve_overlapping_windows(self):
        other = self.make_metadata('two')
        other['window'] = {'start': 11, 'end': 20, 'duration': 9}
        other['publicationReview']['artifactWindow'] = copy.deepcopy(other['window'])
        path = self.root / 'two.json'
        path.write_text(json.dumps(other), encoding='utf-8')
        self.data['clips']['2'] = {**load_upload_manifest(path)[0], 'id': 2, 'status': 'review',
                                  'statePath': str(self.root / 'two-state.json')}
        registry.save_json(self.registry_path, self.data)
        result = self.enqueue('1,2')
        self.assertEqual(result['queuedIds'], [1])
        self.assertEqual(result['results'][1]['status'], 'needs_human')
        self.assertIn('duplicate source content', result['results'][1]['error'])

    def test_import_is_side_effect_free_and_preserves_required_flag_and_authorization(self):
        self.enqueue()
        self.metadata.pop("automaticPublicationRequired")
        self.write_metadata()
        args = registry.build_parser().parse_args(["import-json", "--manifest", str(self.metadata_path), "--include-pending"])
        with redirect_stdout(io.StringIO()):
            self.assertEqual(registry.import_json(args), 0)
        saved, queue = self.saved()
        self.assertEqual(len(queue["jobs"]), 1)
        clip = saved["clips"]["1"]
        self.assertTrue(clip["automaticPublicationRequired"])
        self.assertTrue(clip["automaticPublicationAuthorization"])
        self.assertTrue(clip["reviewPending"])

    def test_force_is_never_an_automatic_policy_override(self):
        args = registry.build_parser().parse_args(["enqueue", "--ids", "1", "--automatic", "--force"])
        self.assertEqual(registry.enqueue(args), 2)
        self.assertFalse(self.queue_path.exists())

    def test_restart_recovers_registry_write_before_queue_commit_without_duplicate_submission(self):
        self.enqueue()
        # Simulate losing only the final queue-file commit after the registry authorization was saved.
        self.queue_path.unlink()
        self.assertEqual(self.enqueue()["queuedIds"], [1])
        self.assertEqual(len(self.saved()[1]["jobs"]), 1)

    def prepared_retry(self):
        self.metadata["output"]["metadataPath"] = str(self.metadata_path)
        self.write_metadata()
        self.enqueue()
        saved, queue = self.saved()
        original_authorization = copy.deepcopy(saved["clips"]["1"]["automaticPublicationAuthorization"])
        prior = self.root / "prior-metadata.json"
        prior.write_text(json.dumps(self.metadata), encoding="utf-8")
        queue["jobs"][0].update(status="failed", error="automatic submission outcome unknown",
            startedAt=(dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=10)).isoformat(),
            updatedAt=(dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=10)).isoformat())
        registry.save_json(self.queue_path, queue)
        self.metadata["window"].update(end=30, duration=20)
        self.metadata["copy"]["title"] = "Fresh title"
        self.metadata["publicationReview"]["digests"]["copy"] = hashlib.sha256("\0".join(
            self.metadata["copy"][key] for key in ("title", "coverText", "description")).encode()).hexdigest()
        self.metadata["publicationReview"]["artifactWindow"] = copy.deepcopy(self.metadata["window"])
        self.write_metadata()
        args = registry.build_parser().parse_args(["import-json", "--manifest", str(self.metadata_path), "--include-pending",
            "--state", saved["clips"]["1"]["statePath"]])
        with redirect_stdout(io.StringIO()):
            self.assertEqual(registry.import_json(args), 0)
        return prior, original_authorization

    def test_explicit_retry_reconciles_old_bound_title_and_queues_fresh_authorization_without_changing_history(self):
        prior, old = self.prepared_retry()
        rows = [{"title": "Other", "bvid": "BVother", "pubdate": int(dt.datetime.now(dt.timezone.utc).timestamp()) - 3600}]
        with patch.object(automatic_retry, "lookup_member_archives", return_value=rows) as lookup:
            self.assertEqual(self.enqueue(prior_metadata=str(prior))["queuedIds"], [1])
        lookup.assert_called_once()
        saved, queue = self.saved()
        clip = saved["clips"]["1"]
        self.assertFalse(clip["reviewPending"])
        self.assertEqual(clip["automaticPublicationAuthorizationHistory"][0]["authorization"], old)
        self.assertNotEqual(clip["automaticPublicationAuthorization"], old)
        self.assertEqual(queue["jobs"][0]["status"], "failed")
        self.assertEqual(len(queue["jobs"]), 2)
        self.assertEqual(clip["automaticPublicationReconciliation"]["result"], "no_matching_archive")
        self.assertEqual(publication.validate_job_authorizations([[clip]], queue["jobs"][1], lambda: self.config), [])
        self.assertNotIn("ownStreamHumanReview", self.metadata)
        queue["jobs"][1]["status"] = "running"
        registry.save_json(self.queue_path, queue)
        upload_clip = load_upload_manifest(self.metadata_path)[0]
        intent = {"title": "PrefixTitle", "mediaPath": self.metadata["output"]["mediaPath"]}
        other = {"title": "Unresolved other", "mediaPath": "other.mp4"}
        state = {"submission_intents": {"1": intent, "2": other}}
        self.assertTrue(automatic_retry.consume_reconciled_intent(state, upload_clip, queue["jobs"][1]["id"], registry))
        self.assertEqual(state["submission_intents"], {"2": other})
        self.assertEqual(state["reconciled_submission_intents"][0]["intent"], intent)
        for changed in ({**intent, "title": "Different old title"}, {**intent, "mediaPath": "another.mp4"}):
            state = {"submission_intents": {"1": changed}}
            self.assertFalse(automatic_retry.consume_reconciled_intent(state, upload_clip, queue["jobs"][1]["id"], registry))
            self.assertEqual(state, {"submission_intents": {"1": changed}})
        self.policy["mode"] = "off"
        state = {"submission_intents": {"1": intent}}
        with self.assertRaisesRegex(ValueError, "authorization invalid"):
            automatic_retry.consume_reconciled_intent(state, upload_clip, queue["jobs"][1]["id"], registry)
        self.assertEqual(state, {"submission_intents": {"1": intent}})

    def test_retry_refuses_an_existing_archive_incomplete_history_lookup_or_missing_quality_review(self):
        prior, old = self.prepared_retry()
        now = int(dt.datetime.now(dt.timezone.utc).timestamp())
        good = [{"title": "Other", "bvid": "BVother", "pubdate": now - 3600}]
        cases = [("existing", [{"title": "PrefixTitle", "bvid": "BVexisting", "pubdate": now - 3600}]),
            ("current", [{"title": "PrefixFresh title", "bvid": "BVexisting", "pubdate": now - 3600}]),
            ("partial", [{"title": "Other", "bvid": "BVother", "pubdate": now - 60}]),
            ("network", RuntimeError("lookup unavailable")), ("quality", good), ("copy", good)]
        prior_bytes = prior.read_bytes()
        for kind, rows in cases:
            with self.subTest(kind=kind):
                saved, queue = self.saved()
                before = self.registry_path.read_bytes()
                if kind == "quality":
                    saved["clips"]["1"]["qaRequired"] = True
                    registry.save_json(self.registry_path, saved)
                    before = self.registry_path.read_bytes()
                if kind == "copy":
                    wrong = json.loads(prior_bytes)
                    wrong["copy"]["title"] = "Different prior title"
                    prior.write_text(json.dumps(wrong), encoding="utf-8")
                kwargs = {"side_effect": rows} if isinstance(rows, Exception) else {"return_value": rows}
                with patch.object(automatic_retry, "lookup_member_archives", **kwargs):
                    self.assertEqual(self.enqueue(prior_metadata=str(prior))["queuedIds"], [])
                self.assertEqual(self.registry_path.read_bytes(), before)
                self.assertEqual(len(self.saved()[1]["jobs"]), 1)
                self.assertEqual(self.saved()[0]["clips"]["1"]["automaticPublicationAuthorization"], old)
                prior.write_bytes(prior_bytes)
                saved["clips"]["1"].pop("qaRequired", None)
                registry.save_json(self.registry_path, saved)

    def test_retry_dry_run_leaves_registry_queue_and_authorization_unchanged(self):
        prior, _old = self.prepared_retry()
        before = self.registry_path.read_bytes(), self.queue_path.read_bytes()
        args = registry.build_parser().parse_args(["retry-auto", "--id", "1", "--prior-metadata", str(prior), "--dry-run"])
        rows = [{"title": "Other", "bvid": "BVother", "pubdate": int(dt.datetime.now(dt.timezone.utc).timestamp()) - 3600}]
        with patch.object(automatic_retry, "lookup_member_archives", return_value=rows), redirect_stdout(io.StringIO()):
            self.assertEqual(args.func(args), 0)
        self.assertEqual((self.registry_path.read_bytes(), self.queue_path.read_bytes()), before)

    def test_retry_waits_from_the_end_of_a_long_prior_upload(self):
        prior, _old = self.prepared_retry()
        saved, queue = self.saved()
        queue["jobs"][0]["updatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        registry.save_json(self.queue_path, queue)
        before = self.registry_path.read_bytes(), self.queue_path.read_bytes()
        with patch.object(automatic_retry, "lookup_member_archives") as lookup:
            self.assertEqual(self.enqueue(prior_metadata=str(prior))["queuedIds"], [])
        lookup.assert_not_called()
        self.assertEqual((self.registry_path.read_bytes(), self.queue_path.read_bytes()), before)

    def test_active_or_recent_prior_attempt_cannot_be_reconciled(self):
        prior, _old = self.prepared_retry()
        for status in ("pending", "failed"):
            saved, queue = self.saved()
            queue["jobs"][0].update(status=status, startedAt=dt.datetime.now(dt.timezone.utc).isoformat())
            registry.save_json(self.queue_path, queue)
            with patch.object(automatic_retry, "lookup_member_archives") as lookup:
                self.assertEqual(self.enqueue(prior_metadata=str(prior))["queuedIds"], [])
            lookup.assert_not_called()

    def test_topic_policy_queues_other_host_once_without_own_stream_authorization(self):
        self.use_topic()
        self.assertEqual(self.enqueue()["queuedIds"], [1])
        saved, queue = self.saved()
        clip, job = saved["clips"]["1"], queue["jobs"][0]
        authority = clip["automaticPublicationAuthorization"]
        self.assertEqual(authority["policyVersion"], "topic-v1")
        self.assertEqual(authority["topicScope"], {"scope": "configured_keywords", "keywords": ["SUI", "小岁"],
                                                  "ignoredRoomIds": ["25788785"]})
        self.assertEqual(publication.validate_job_authorizations([[clip]], job, lambda: self.config), [])
        self.assertEqual(self.enqueue()["results"], [{"id": 1, "status": "already_queued"}])
        self.assertNotIn("ownStreamHumanReview", self.metadata)

    def test_topic_policy_rechecks_target_and_room_before_every_actual_submission(self):
        self.use_topic()
        self.enqueue()
        saved, queue = self.saved()
        clip, job = saved["clips"]["1"], queue["jobs"][0]
        settings = self.config["clipTopics"]
        original = copy.deepcopy(settings)
        for change in ({"enabled": False}, {"keywords": []}, {"keywords": ["unrelated"]},
                       {"keywords": ["小岁", "new-target"]}, {"keywords": [None]},
                       {"ignoredRoomIds": ["other-host"]}, {"ignoredRoomIds": "invalid"}):
            with self.subTest(change=change):
                settings.update(change)
                self.assertTrue(publication.validate_job_authorizations([[clip]], job, lambda: self.config))
                settings.clear()
                settings.update(copy.deepcopy(original))
        for change in ({"mode": "off"}, {"scope": "all"}, {"policyVersion": "own-stream-v1"},
                       {"activatedAt": "2026-10-04T00:00:00Z"}):
            with self.subTest(change=change):
                settings["automaticPublication"].update(change)
                self.assertTrue(publication.validate_job_authorizations([[clip]], job, lambda: self.config))
                settings.clear()
                settings.update(copy.deepcopy(original))
        # Ordering alone is not a changed scope; sets are stored canonically.
        settings["keywords"].reverse()
        self.assertEqual(publication.validate_job_authorizations([[clip]], job, lambda: self.config), [])
        queue["jobs"][0]["status"] = "running"
        registry.save_json(self.queue_path, queue)
        upload_clip = load_upload_manifest(self.metadata_path)[0]
        publication.validate_submission_authorization(upload_clip, job["id"], registry)
        settings["ignoredRoomIds"].append("other-host")
        with self.assertRaisesRegex(ValueError, "authorization invalid"):
            publication.validate_submission_authorization(upload_clip, job["id"], registry)

    def test_topic_final_pass_cannot_promote_pending_candidates_or_unresolved_preflight(self):
        self.use_topic()
        original = copy.deepcopy(self.metadata)
        mutations = [lambda m: m.update(status="pending_preflight"), lambda m: m.update(status="render_queued"),
                     lambda m: m.update(status="partial"), lambda m: m.update(mode="topic_candidate_manual_cut"),
                     lambda m: m.pop("publicationKind"), lambda m: m["source"].update(sourceKind="audio"),
                     lambda m: m["aiReview"].update(mode="shadow"), lambda m: m["aiReview"].update(applied=False),
                     lambda m: m["aiReview"]["quality"].update(issues=["subtitle uncertain"]),
                     lambda m: m["aiReview"]["keyword"]["hits"][0].update(end=21),
                     lambda m: m["aiReview"]["keyword"]["hits"][0].update(evidenceCueIds=[]),
                     lambda m: m["aiReview"]["keyword"]["hits"][0].update(reason=""),
                     lambda m: m["aiReview"]["keyword"]["hits"][0].update(verdict="uncertain"),
                     lambda m: m["editorial"].update(sourceKind="uncertain"),
                     lambda m: m["editorial"]["copyGrounding"].update(issues=["unsupported_quote"]),
                     lambda m: m["aiReview"]["boundaryReview"].update(unresolvedCueIds=["G2"])]
        for mutate in mutations:
            self.metadata = copy.deepcopy(original)
            mutate(self.metadata)
            # Even a forged generic final pass that copies unresolved evidence must not erase these gates.
            self.metadata["publicationReview"]["topicEvidence"] = {key: copy.deepcopy(self.metadata.get(key))
                for key in ("publicationKind", "aiReview", "editorial")}
            with self.assertRaises(ValueError):
                publication.validate_publication_review(self.metadata)

    def test_topic_review_binds_editorial_and_keyword_evidence_and_source_files(self):
        self.use_topic()
        original = copy.deepcopy(self.metadata)
        for mutate in (lambda m: m["aiReview"]["keyword"]["hits"][0].update(reason="Changed identity explanation"),
                       lambda m: m["editorial"].update(event="Changed event"),
                       lambda m: m["editorial"]["copyGrounding"].update(subtitles=[{"text": "Changed evidence"}])):
            self.metadata = copy.deepcopy(original)
            mutate(self.metadata)
            with self.assertRaisesRegex(ValueError, "evidence changed"):
                publication.validate_publication_review(self.metadata)
        self.metadata = copy.deepcopy(original)
        xml = self.root / "source.xml"
        xml.write_text("audience", encoding="utf-8")
        self.metadata["source"]["xmlPath"] = str(xml)
        self.metadata["publicationReview"]["source"] = publication.source_snapshot(self.metadata)
        publication.validate_publication_review(self.metadata)
        xml.write_text("changed audience", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "source changed"):
            publication.validate_publication_review(self.metadata)

    def test_topic_pending_import_keeps_id_and_never_auto_enqueues(self):
        self.use_topic()
        self.metadata["publicationReview"].update(status="needs_review", issues=["uncertain speaker"])
        self.metadata["publicationDecision"].update(action="needs_human", reasons=["uncertain speaker"])
        self.write_metadata()
        args = registry.build_parser().parse_args(["import-json", "--manifest", str(self.metadata_path), "--include-pending"])
        with redirect_stdout(io.StringIO()):
            self.assertEqual(registry.import_json(args), 0)
        saved, queue = self.saved()
        self.assertEqual(list(saved["clips"]), ["1"])
        self.assertTrue(saved["clips"]["1"]["reviewPending"])
        self.assertIn("uncertain speaker", saved["clips"]["1"]["reviewIssues"])
        self.assertFalse(queue.get("jobs"))
        self.assertEqual(self.enqueue()["queuedIds"], [])


if __name__ == "__main__":
    unittest.main()
