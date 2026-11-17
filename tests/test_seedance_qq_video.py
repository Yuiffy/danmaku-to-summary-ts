"""Offline contracts for QQ admission, Canvas billing gates and scheduler routing."""
import copy
import hashlib
import json
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import seedance_qq_bridge as bridge
import seedance_canvas as canvas
import seedance_queue_runner as runner
from seedance_queue_store import QueueStore


class QQVideoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.queue = self.root / "queue.json"
        self.queue.write_text('{"tasks":[]}', encoding="utf-8")
        self.image = self.root / "image.png"
        self.image.write_bytes(b"image")
        self.owner = dict(app="900000001", user="a" * 64, conversation="b" * 64, request="c" * 64)
        self.payload = dict(action="enqueue", owner=self.owner, prompt="@Image 1 walks", images=[str(self.image)], audio=[],
                            model="seedance2.0fast_vip", ratio="9:16", duration=15, resolution="720p", direct=False,
                            draft=dict(prompt="@Image 1 walks", creativeText="walks", materials=["image"], sourceCount=1, command={}))

    def tearDown(self):
        self.temp.cleanup()

    def enqueue(self, **extra):
        return bridge.handle(self.queue, {**self.payload, **extra})

    def tasks(self):
        return QueueStore(self.queue).load()["tasks"]

    def action(self, action, **extra):
        return bridge.handle(self.queue, dict(action=action, owner=self.owner, **extra))

    def test_draft_is_not_schedulable_even_after_normalization_or_reservation(self):
        self.assertEqual(self.enqueue()["status"], "draft")
        data = QueueStore(self.queue).load()
        runner.normalize_data(data)
        self.assertEqual(data["tasks"][0]["status"], "draft")
        self.assertEqual(runner.select_submission_tasks(data, runner.RunnerOptions()), [])
        self.assertIsNone(runner.reserve_submission(QueueStore(self.queue), data["tasks"][0]["id"])[0])

    def test_approval_and_replay_keep_one_task_and_all_public_identities(self):
        self.enqueue()
        before = self.tasks()[0]["canvas"]
        self.assertEqual(self.action("approve")["status"], "pending")
        self.assertEqual(self.action("approve")["status"], "pending")
        self.assertEqual(self.enqueue()["status"], "pending")
        self.assertEqual(len(self.tasks()), 1)
        self.assertEqual(self.tasks()[0]["canvas"], before)
        self.assertEqual(self.tasks()[0]["repeat"], 1)

    def test_concurrent_admission_deduplicates_under_existing_lock(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.enqueue(), range(4)))
        self.assertEqual(len({result["taskId"] for result in results}), 1)
        self.assertEqual(len(self.tasks()), 1)

    def test_edit_replaces_only_unscheduled_draft_and_cancelled_is_not_scheduled(self):
        self.enqueue()
        self.owner = {**self.owner, "request": "d" * 64}
        self.payload["owner"] = self.owner
        self.enqueue()
        self.assertEqual([task["status"] for task in self.tasks()], ["cancelled", "draft"])
        data = QueueStore(self.queue).load()
        runner.normalize_data(data)
        self.assertEqual(runner.select_submission_tasks(data, runner.RunnerOptions()), [])
        self.action("approve")
        self.owner = {**self.owner, "request": "e" * 64}
        self.payload["owner"] = self.owner
        self.assertEqual(self.enqueue()["status"], "busy")

    def test_status_draft_and_approval_are_bound_to_user_and_group(self):
        self.enqueue()
        for field in ("user", "conversation", "app"):
            other = {**self.owner, field: "900000002" if field == "app" else "f" * 64}
            for action in ("draft", "status", "approve", "confirm"):
                self.assertEqual(bridge.handle(self.queue, dict(action=action, owner=other))["status"], "missing")
        self.assertEqual(self.tasks()[0]["status"], "draft")

    def test_direct_generation_is_pending_and_text_only_is_valid(self):
        result = self.enqueue(direct=True, images=[], prompt="rain", draft=dict(prompt="rain", materials=[], sourceCount=0))
        self.assertEqual(result["status"], "pending")
        self.assertEqual(self.tasks()[0]["canvas"]["imageResourceIds"], [])
        self.assertIsNone(runner.validate_profile(self.tasks()[0]))
        task = self.tasks()[0]
        calls, call = self.provider(task)
        with patch.object(canvas, "cli", side_effect=call):
            canvas.submit(task, self.queue)
        saved = next(args for args in calls if args[:2] == ["node", "create"])
        self.assertEqual(saved[saved.index("--mode") + 1], "t2v")
        self.assertNotIn("--ref", saved)

    def test_canvas_node_identity_matches_cli_crockford_contract(self):
        task = self.prepared()
        self.assertRegex(task["canvas"]["nodeId"], r"^node_[0123456789abcdefghjkmnpqrstvwxyz]{10}$")

    def test_display_name_does_not_change_owner_identity_or_replay(self):
        self.enqueue(senderName="小鱼\n昵称")
        self.assertEqual(self.tasks()[0]["qq"], self.owner)
        self.assertEqual(self.tasks()[0]["qq_sender_name"], "小鱼 昵称")
        self.enqueue(senderName="改名")
        self.assertEqual(len(self.tasks()), 1)

    def test_cli_reads_structured_errors_from_stderr(self):
        error = dict(ok=False, error=dict(code="cli.invalid_command", **{"class": "invalid_input"},
                     validation=dict(reasonCode="CLI_NODE_ID_INVALID")))
        result = canvas.subprocess.CompletedProcess([], 2, stdout="", stderr=json.dumps(error))
        with patch.object(canvas.subprocess, "run", return_value=result):
            envelope = canvas.cli(["node", "create"])
        self.assertEqual(envelope, error)
        self.assertEqual(canvas.failure(envelope), "invalid_request")

    def test_cli_rejects_malformed_or_false_success_process_results(self):
        cases = [(0, "not json", ""), (1, json.dumps(dict(ok=True, data={})), ""),
                 (0, json.dumps(dict(ok="true")), "")]
        for code, stdout, stderr in cases:
            with self.subTest(code=code, stdout=stdout):
                result = canvas.subprocess.CompletedProcess([], code, stdout=stdout, stderr=stderr)
                with patch.object(canvas.subprocess, "run", return_value=result), self.assertRaises(canvas.CanvasRejected):
                    canvas.cli(["node", "create"])

    def test_unsupported_profile_and_unavailable_references_do_not_write(self):
        for extra in (dict(model="seedance2.5"), dict(resolution="1080p"), dict(duration=16), dict(audio=[str(self.image)], images=[])):
            with self.assertRaises(ValueError):
                self.enqueue(**extra)
        self.assertEqual(self.tasks(), [])

    def test_explicit_credit_approval_reuses_task_and_cannot_underapprove(self):
        self.enqueue(direct=True)
        store = QueueStore(self.queue)
        with store.transaction() as data:
            task = data["tasks"][0]
            task.update(status="paused", failure_code="confirmation_required", required_credits=90)
            ids = copy.deepcopy(task["canvas"])
            store.save(data)
        with self.assertRaises(ValueError):
            self.action("confirm", credits=89)
        self.assertEqual(self.action("confirm", credits=90)["status"], "pending")
        self.assertEqual(self.tasks()[0]["canvas"], {**ids, "approvedCredits": 90})

    def prepared(self):
        self.enqueue(direct=True)
        return self.tasks()[0]

    def provider(self, task, *, confirmation=False, total=90, lose_run=False):
        calls = []
        def call(args):
            calls.append(args)
            verb = tuple(args[:2])
            data = {}
            if verb == ("resource", "upload"):
                data = dict(resourceId=args[args.index("--resource-id") + 1], mediaType=args[args.index("--type") + 1])
            elif verb == ("node", "create"):
                data = dict(node=dict(nodeId=task["canvas"]["nodeId"]))
            elif verb == ("node", "quote"):
                data = dict(items=[dict(nodeId=task["canvas"]["nodeId"], maxCredits=total)], totalMaxCredits=total, confirmationRequired=confirmation)
            elif verb == ("node", "confirm"):
                data = dict(creditConfirmationToken="private-credit-token")
            elif verb == ("node", "run"):
                state = json.loads(canvas.state_file(task, self.queue).read_text(encoding="utf-8"))
                self.assertEqual(state["phase"], "run_intent")
                if lose_run:
                    raise TimeoutError("response lost")
                data = dict(items=[dict(nodeId=task["canvas"]["nodeId"], state="accepted")])
            return dict(ok=True, data=data)
        return calls, call

    def test_reference_video_survives_draft_and_uploads_as_video_in_multimodal_mode(self):
        video = self.root / "reference.mp4"
        video.write_bytes(b"0000ftypisom0000")
        prompt = "@Video 1 actions, @Image 1 appearance"
        draft = dict(prompt=prompt, materials=["image", "video"], sourceCount=1, videoSourceCount=1)
        self.enqueue(videos=[str(video)], videoDurationsMs=[3000], prompt=prompt, draft=draft)
        self.assertEqual(self.action("draft")["videos"], [dict(file=str(video), durationMs=3000)])
        self.action("approve")
        task = self.tasks()[0]
        self.assertIsNone(runner.validate_profile(task))
        calls, call = self.provider(task)
        with patch.object(canvas, "cli", side_effect=call):
            canvas.submit(task, self.queue)
        upload = next(args for args in calls if args[:2] == ["resource", "upload"] and args[args.index("--type") + 1] == "video")
        self.assertEqual(upload[upload.index("--file") + 1], str(video))
        saved = next(args for args in calls if args[:2] == ["node", "create"])
        self.assertEqual(saved[saved.index("--mode") + 1], "m2v")
        self.assertEqual(saved[saved.index("--prompt") + 1], "{{res:" + task["canvas"]["videoResourceIds"][0] +
                         "}} actions, {{res:" + task["canvas"]["imageResourceIds"][0] + "}} appearance")

    def test_video_only_can_generate_and_invalid_reference_metadata_never_enters_queue(self):
        video = self.root / "reference.mp4"
        video.write_bytes(b"0000ftypisom0000")
        draft = dict(prompt="@Video 1 continue", materials=["video"], sourceCount=0, videoSourceCount=1)
        extra = dict(images=[], videos=[str(video)], videoDurationsMs=[3000], prompt=draft["prompt"], draft=draft, direct=True)
        for invalid in [dict(videoDurationsMs=[1000]), dict(videoDurationsMs=[True]), dict(videoDurationsMs=[]),
                        dict(videos=[str(video)] * 3, videoDurationsMs=[6000] * 3), dict(draft={**draft, "videoSourceCount":0})]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.enqueue(**{**extra, **invalid})
            self.assertEqual(self.tasks(), [])
        self.enqueue(**extra)
        task = self.tasks()[0]
        self.assertIsNone(runner.validate_profile(task))
        calls, call = self.provider(task)
        with patch.object(canvas, "cli", side_effect=call):
            canvas.submit(task, self.queue)
        saved = next(args for args in calls if args[:2] == ["node", "create"])
        self.assertEqual(saved[saved.index("--mode") + 1], "m2v")
        task["video_references"] = [str(self.root / "missing.mp4")]
        self.assertEqual(runner.validate_profile(task), "video reference missing")

    def test_canvas_saves_canonical_profile_and_binds_frozen_references(self):
        task = self.prepared()
        calls, call = self.provider(task)
        with patch.object(canvas, "cli", side_effect=call):
            self.assertEqual(canvas.submit(task, self.queue), task["canvas"]["submitId"])
        saved = next(args for args in calls if args[:2] == ["node", "create"])
        self.assertEqual(saved[saved.index("--model") + 1], "seedance_2.0_fast_vip")
        self.assertEqual(saved[saved.index("--mode") + 1], "m2v")
        self.assertEqual(saved[saved.index("--prompt") + 1], "{{res:" + task["canvas"]["imageResourceIds"][0] + "}} walks")
        self.assertEqual(saved[saved.index("--count") + 1], "1")

    def test_canvas_automatically_confirms_quote_and_records_usage_without_token(self):
        task = self.prepared()
        calls, call = self.provider(task, confirmation=True)
        with patch.object(canvas, "cli", side_effect=call):
            canvas.submit(task, self.queue)
        self.assertEqual(sum(args[:2] == ["canvas", "create"] for args in calls), 1)
        self.assertEqual(sum(args[:2] == ["node", "run"] for args in calls), 1)
        confirm = next(args for args in calls if args[:2] == ["node", "confirm"])
        self.assertEqual(confirm[-2:], ["--credit-ceiling", "90"])
        self.assertEqual(self.tasks()[0]["credit_usage"]["quoted_credits"], 90)
        self.assertEqual(self.tasks()[0]["credit_usage"]["run_state"], "accepted")
        self.assertNotIn("private-credit-token", canvas.state_file(task, self.queue).read_text(encoding="utf-8"))
        self.assertNotIn("private-credit-token", self.queue.read_text(encoding="utf-8"))

    def test_auto_billing_uses_new_quote_instead_of_legacy_manual_ceiling(self):
        task = self.prepared()
        task["canvas"]["approvedCredits"] = 90
        calls, call = self.provider(task, confirmation=True, total=91)
        with patch.object(canvas, "cli", side_effect=call):
            canvas.submit(task, self.queue)
        confirm = next(args for args in calls if args[:2] == ["node", "confirm"])
        self.assertEqual(confirm[-1], "91")
        self.assertEqual(self.tasks()[0]["credit_usage"]["quoted_credits"], 91)

    def test_unknown_or_invalid_quote_is_never_submitted(self):
        for total in (None, True, -1, 1.5, "90"):
            with self.subTest(total=total):
                task = self.prepared()
                calls, call = self.provider(task, confirmation=True, total=total)
                with patch.object(canvas, "cli", side_effect=call), self.assertRaises(canvas.CanvasRejected):
                    canvas.submit(task, self.queue)
                self.assertFalse(any(args[:2] == ["node", "run"] for args in calls))

    def test_rejected_run_is_recorded_without_counting_it_as_accepted(self):
        task = self.prepared()
        calls, call = self.provider(task, confirmation=True)
        def reject(args):
            if args[:2] == ["node", "run"]:
                return dict(ok=False, error=dict(code="insufficient_credits"))
            return call(args)
        with patch.object(canvas, "cli", side_effect=reject), self.assertRaises(canvas.CanvasRejected):
            canvas.submit(task, self.queue)
        self.assertEqual(self.tasks()[0]["credit_usage"]["run_state"], "rejected")

    def test_old_credit_pause_resumes_only_before_run_intent(self):
        task = self.prepared()
        ids = copy.deepcopy(task["canvas"])
        store = QueueStore(self.queue)
        for phase, expected in (("run_intent", "paused"), ("awaiting_confirmation", "pending")):
            with store.transaction() as data:
                data["tasks"][0].update(status="paused", failure_code="confirmation_required", required_credits=90)
                store.save(data)
            canvas.checkpoint(canvas.state_file(task, self.queue), dict(phase=phase))
            canvas.resume_credit_pauses(store)
            self.assertEqual(self.tasks()[0]["status"], expected)
            self.assertEqual(self.tasks()[0]["canvas"], ids)

    def test_lost_run_response_and_restart_never_repeat_paid_run(self):
        task = self.prepared()
        calls, call = self.provider(task, lose_run=True)
        with patch.object(canvas, "cli", side_effect=call):
            for _ in range(3):
                self.assertEqual(canvas.submit(task, self.queue), task["canvas"]["submitId"])
        self.assertEqual(sum(args[:2] == ["node", "run"] for args in calls), 1)
        self.assertEqual(self.tasks()[0]["credit_usage"]["run_state"], "intent")

    def test_query_only_declares_success_for_one_terminal_resource(self):
        task = self.prepared()
        cases = [(dict(state="running", resources=[]), "querying"),
                 (dict(state="succeeded", resources=[dict(resourceId="video", state="succeeded")]), "success"),
                 (dict(state="success", resources=[]), "querying"),
                 (dict(submission=dict(state="unknown")), "fail"),
                 (dict(submissionError=dict(reason="insufficient_credits")), "fail")]
        for data, status in cases:
            with patch.object(canvas, "cli", return_value=dict(ok=True, data=data)) as cli:
                self.assertEqual(canvas.query(task)["gen_status"], status)
                self.assertEqual(cli.call_args.args[0][:3], ["operation", "status", task["canvas"]["submitId"]])

    def test_only_structured_credit_failures_classify_as_no_credits(self):
        self.assertEqual(canvas.failure(dict(error=dict(code="insufficient_credits"))), "insufficient_credits")
        self.assertEqual(canvas.failure(dict(error=dict(code="other", message="insufficient credits"))), "provider_rejected")
        self.assertEqual(canvas.failure(dict(error="unexpected")), "provider_rejected")

    def test_schema_v2_machine_errors_preserve_auth_input_and_credit_confirmation(self):
        for code, expected in [(2, "invalid_request"), (3, "account_unavailable"),
                               (40018, "confirmation_required"), (987654, "provider_rejected")]:
            self.assertEqual(canvas.failure(dict(error=dict(code=code, message="private details"))), expected)

    def test_download_requires_a_terminal_video_and_checks_bytes_and_receipt(self):
        task = self.prepared()
        data = b"0000ftypisom0000"
        def call(args):
            if args[:2] == ["resource", "get"]:
                return dict(ok=True, data=dict(type="video", status="success"))
            Path(args[-1]).write_bytes(data)
            return dict(ok=True, data=dict(size=len(data), sha256=hashlib.sha256(data).hexdigest()))
        with patch.object(canvas, "cli", side_effect=call):
            self.assertEqual(canvas.download(task, dict(resourceId="resource"), self.root), str((self.root / "video.mp4").resolve()))
        with patch.object(canvas, "cli", return_value=dict(ok=True, data=dict(type="image", status="success"))), self.assertRaises(canvas.CanvasRejected):
            canvas.download(task, dict(resourceId="resource"), self.root)

    def test_runner_routes_canvas_without_calling_legacy_cli_and_pauses_for_confirmation(self):
        task = self.prepared()
        with patch.object(runner, "submit") as legacy, patch.object(canvas, "submit", side_effect=canvas.CanvasRejected("confirmation_required", 90)), patch.object(runner, "maybe_notify_empty_queue"):
            runner.run_once(QueueStore(self.queue), runner.RunnerOptions(submit_delay=0))
        legacy.assert_not_called()
        self.assertEqual(self.tasks()[0]["status"], "paused")
        self.assertEqual(self.tasks()[0]["required_credits"], 90)
        self.assertEqual(self.tasks()[0]["submission_reservations"], [])

    def test_runner_download_failure_retains_attempt_instead_of_regenerating(self):
        task = self.prepared()
        store = QueueStore(self.queue)
        snapshot, token, _ = runner.reserve_submission(store, task["id"])
        runner.apply_submission_success(store, task["id"], token, task["canvas"]["submitId"])
        with patch.object(canvas, "query", return_value=dict(gen_status="success", resourceId="video")), patch.object(canvas, "download", side_effect=OSError("network")), patch.object(runner, "submit") as legacy:
            runner.sync_due_attempts(store, False)
        legacy.assert_not_called()
        self.assertEqual(len(self.tasks()[0]["inflight"]), 1)
        self.assertEqual(self.tasks()[0]["completed"], 0)


if __name__ == "__main__":
    unittest.main()
