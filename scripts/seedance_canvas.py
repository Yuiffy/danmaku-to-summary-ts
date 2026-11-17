"""Dreamina Canvas provider for QQ jobs in the shared Seedance scheduler.

Only public CLI identities enter state. Run intent is durable before paid IO;
uncertain runs are observed through operation status, never submitted again.
"""
from __future__ import annotations

import json
import hashlib
import os
import subprocess
import time
from pathlib import Path
from seedance_queue_store import QueueStore

MODELS = {"seedance2.0fast_vip": "seedance_2.0_fast_vip", "seedance2.0mini": "seedance_2.0_mini"}


class CanvasRejected(RuntimeError):
    def __init__(self, code, credits=None):
        super().__init__(code)
        self.code = code
        self.credits = credits


def cli(args):
    cp = subprocess.run(["dreamina-canvas", "--format", "json", "--non-interactive", *args],
                        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
    # CLI failures use stderr; preserve their machine error instead of masking it as an outage.
    for raw in (cp.stdout, cp.stderr):
        try:
            result = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if isinstance(result, dict) and isinstance(result.get("ok"), bool):
            if cp.returncode != 0 and result["ok"]:
                continue
            return result
    raise CanvasRejected("provider_unavailable")


def failure(envelope):
    if not isinstance(envelope, dict):
        return "provider_rejected"
    error = envelope.get("error") or envelope.get("submissionError") or envelope
    if not isinstance(error, dict):
        return "provider_rejected"
    # Schema v2 replaces v1 class/requiredAction with stable numeric machine codes.
    numeric = {2: "invalid_request", 3: "account_unavailable", 40018: "confirmation_required"}
    if type(error.get("code")) is int and error["code"] in numeric:
        return numeric[error["code"]]
    validation = error.get("validation") if isinstance(error.get("validation"), dict) else {}
    # Machine fields only. Provider-localized messages must never control billing decisions.
    code = str(validation.get("reasonCode") or error.get("code") or error.get("reason") or "").lower()
    if ("credit" in code or "balance" in code) and any(word in code for word in ("insufficient", "not_enough", "notenough")):
        return "insufficient_credits"
    if error.get("requiredAction") in {"login", "authenticate"} or code.startswith("auth."):
        return "account_unavailable"
    if error.get("requiredAction") == "confirm" or "confirmation_required" in code:
        return "confirmation_required"
    if error.get("class") == "invalid_input":
        return "invalid_request"
    return "provider_rejected"


def require(envelope):
    if not envelope["ok"]:
        raise CanvasRejected(failure(envelope), (envelope.get("creditConfirmation") or {}).get("minimumCreditCeiling"))
    return envelope.get("data") or {}


def state_file(task, queue):
    return queue.parent / "qq-canvas" / f"{task['id']}.json"


def checkpoint(file, state):
    file.parent.mkdir(parents=True, exist_ok=True)
    tmp = file.with_suffix(".tmp")
    try:
        with tmp.open("w", encoding="utf-8") as out:
            json.dump(state, out, ensure_ascii=False)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, file)
    finally:
        tmp.unlink(missing_ok=True)


def record_usage(task, queue, credits, phase):
    """One quote per stable submit ID; estimates never claim final settlement."""
    store = QueueStore(queue)
    with store.transaction() as data:
        current = next(item for item in data["tasks"] if item["id"] == task["id"])
        current["credit_usage"] = {"submit_id": task["canvas"]["submitId"],
                                   "quoted_credits": credits, "run_state": phase,
                                   "updated_at": int(time.time())}
        store.save(data)


def resume_credit_pauses(store):
    """Resume old pre-run credit prompts, preserving every public operation ID."""
    with store.transaction() as data:
        changed = False
        for task in data["tasks"]:
            if (task.get("backend") != "dreamina-canvas" or not task.get("qq") or
                    task.get("status") != "paused" or task.get("failure_code") != "confirmation_required" or
                    task.get("inflight") or task.get("submission_reservations")):
                continue
            if not isinstance(task.get("id"), str) or not task["id"].startswith("qq_") or Path(task["id"]).name != task["id"]:
                continue
            try:
                state = json.loads(state_file(task, store.path).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if state.get("phase") != "awaiting_confirmation":
                continue
            task["status"] = "pending"
            task.pop("failure_code", None)
            task.pop("required_credits", None)
            changed = True
        if changed:
            store.save(data)


def submit(task, queue):
    config = task["canvas"]
    file = state_file(task, queue)
    state = json.loads(file.read_text(encoding="utf-8")) if file.exists() else {"phase": "new"}
    if state["phase"] in {"run_intent", "observing"}:
        return config["submitId"]
    if state["phase"] not in {"new", "awaiting_confirmation"}:
        raise CanvasRejected("needs_review")
    project, node = config["projectId"], config["nodeId"]
    if state["phase"] == "new":
        state["phase"] = "preparing"
        checkpoint(file, state)
        require(cli(["canvas", "create", "QQ视频", "--project-id", project]))
        image_ids, audio_ids, video_ids = config["imageResourceIds"], config["audioResourceIds"], config.get("videoResourceIds", [])
        for media_type, paths, ids in (("image", task["reference_images"], image_ids), ("audio", task["audio_references"], audio_ids),
                                      ("video", task.get("video_references", []), video_ids)):
            if len(paths) != len(ids):
                raise CanvasRejected("invalid_reference")
            for index, (local, resource) in enumerate(zip(paths, ids)):
                uploaded = require(cli(["resource", "upload", "--project-id", project, "--file", local,
                                        "--type", media_type, "--resource-id", resource, "--name", f"{media_type}-{index + 1}"]))
                if uploaded.get("resourceId") != resource or uploaded.get("mediaType") != media_type:
                    raise CanvasRejected("invalid_reference")
        prompt = task["prompt"].replace("{{", "\\{{")
        for kind, ids in (("Image", image_ids), ("Audio", audio_ids), ("Video", video_ids)):
            for index in reversed(range(len(ids))):
                prompt = prompt.replace(f"@{kind} {index + 1}", "{{res:" + ids[index] + "}}")
        if len(prompt) > 4000:
            raise CanvasRejected("prompt_too_long")
        args = ["node", "create", "video", "--project-id", project, "--node-id", node,
                "--update-id", config["updateId"], "--title", "QQ视频", "--mode", "m2v" if image_ids or video_ids else "t2v",
                "--prompt", prompt, "--model", MODELS[task["model_version"]], "--resolution", "720p",
                "--duration", str(task["duration"]), "--ratio", task["ratio"], "--count", "1"]
        for resource in image_ids + audio_ids + video_ids:
            args.extend(["--ref", "res:" + resource])
        saved = require(cli(args))
        if saved.get("node", {}).get("nodeId") != node:
            raise CanvasRejected("invalid_node")
        state["phase"] = "awaiting_confirmation"
        checkpoint(file, state)
    quote = require(cli(["node", "quote", "--project-id", project, "--node-id", node]))
    if not quote.get("items") or any(item.get("error") for item in quote["items"]):
        problem = next((item["error"] for item in quote.get("items", []) if item.get("error")), {})
        raise CanvasRejected(failure(problem))
    total = quote.get("totalMaxCredits")
    # The operator authorized automatic billing for QQ video requests. Always use
    # the current authoritative quote, including jobs with an old manual ceiling.
    if type(total) is not int or not 0 <= total <= 9007199254740991:
        raise CanvasRejected("billing_unavailable")
    record_usage(task, queue, total, "quoted")
    token = None
    if quote.get("confirmationRequired"):
        approved = require(cli(["node", "confirm", "--project-id", project, "--node-id", node, "--credit-ceiling", str(total)]))
        token = approved.get("creditConfirmationToken")
        if not isinstance(token, str) or not token:
            raise CanvasRejected("billing_unavailable")
    record_usage(task, queue, total, "intent")
    state["phase"] = "run_intent"
    checkpoint(file, state)
    args = ["node", "run", "--project-id", project, "--node-id", node, "--submit-id", config["submitId"]]
    if token:
        args.extend(["--credit-token", token])
    try:
        result = cli(args)
    except Exception:
        # The same operation reference remains queryable even if its first run response was lost.
        return config["submitId"]
    if not result["ok"]:
        code = failure(result)
        if code in {"insufficient_credits", "account_unavailable", "confirmation_required"}:
            record_usage(task, queue, total, "rejected")
            state["phase"] = "awaiting_confirmation" if code == "confirmation_required" else "rejected"
            checkpoint(file, state)
            raise CanvasRejected(code, (result.get("creditConfirmation") or {}).get("minimumCreditCeiling"))
        return config["submitId"]
    items = result.get("data", {}).get("items") or []
    if len(items) == 1 and items[0].get("state", "").lower() == "rejected":
        state["phase"] = "rejected"
        checkpoint(file, state)
        record_usage(task, queue, total, "rejected")
        raise CanvasRejected(failure(items[0].get("error") or {}))
    if len(items) == 1 and items[0].get("state", "").lower() in {"accepted", "running", "success", "succeeded"}:
        record_usage(task, queue, total, "accepted")
    state["phase"] = "observing"
    checkpoint(file, state)
    return config["submitId"]


def query(task):
    config = task["canvas"]
    result = require(cli(["operation", "status", config["submitId"], "--project-id", config["projectId"]]))
    resources = result.get("resources") or []
    if result.get("submissionError"):
        return {"gen_status": "fail", "failure_code": failure(result)}
    if any(resource.get("state", "").lower() in {"failed", "canceled"} for resource in resources):
        return {"gen_status": "fail", "failure_code": "provider_rejected"}
    if result.get("state", "").lower() in {"failed", "canceled", "cancelled"}:
        return {"gen_status": "fail", "failure_code": "provider_rejected"}
    if result.get("state", "").lower() in {"success", "succeeded"} and len(resources) == 1 and resources[0].get("state", "").lower() in {"success", "succeeded"}:
        return {"gen_status": "success", "resourceId": resources[0]["resourceId"]}
    if result.get("submission", {}).get("state") in {"absent", "unknown"}:
        return {"gen_status": "fail", "failure_code": "needs_review"}
    return {"gen_status": "querying"}


def download(task, result, directory):
    resource = result["resourceId"]
    project = task["canvas"]["projectId"]
    fact = require(cli(["resource", "get", resource, "--project-id", project]))
    if fact.get("type") != "video" or fact.get("status") != "success":
        raise CanvasRejected("invalid_output")
    output = directory / "video.mp4"
    receipt = require(cli(["resource", "download", resource, "--project-id", project, "--output", str(output)]))
    if output.is_symlink() or not output.is_file() or not 12 <= output.stat().st_size <= 100 * 1024 * 1024:
        raise CanvasRejected("invalid_output")
    with output.open("rb") as media:
        if media.read(12)[4:8] != b"ftyp":
            raise CanvasRejected("invalid_output")
        media.seek(0)
        checksum = hashlib.file_digest(media, "sha256").hexdigest()
    if receipt.get("size") != output.stat().st_size or receipt.get("sha256") != checksum:
        raise CanvasRejected("invalid_output")
    return str(output.resolve())
