"""Node text-generation ownership and the Python process boundary."""

import json
import hashlib
import os
import shutil
import subprocess


def run_node_text_generation(prompt, script_path, config, rollout_percent, validate, log=print):
    node = shutil.which("node")
    if not node or not os.path.exists(script_path):
        return None
    policy = config.get("ai", {}).get("comic", {}).get("textGeneration", {}) or {}

    def milliseconds(key, default):
        try:
            return max(1, int(policy.get(key) or default))
        except (TypeError, ValueError):
            return default

    request_timeout = milliseconds("requestTimeoutMs", 120000)
    total_timeout = milliseconds("totalTimeoutMs", 240000)
    args = [node, script_path, "--generate-text", "--timeout-ms", str(request_timeout),
            "--total-timeout-ms", str(total_timeout), "--min-output-chars", "40"]
    if rollout_percent is not None:
        args.extend(["--prompt-cache-rollout-percent", str(rollout_percent)])
    log(f"[AI] Node text owner: timeout={request_timeout}ms, total={total_timeout}ms")
    try:
        result = subprocess.run(
            args, input=prompt.encode("utf-8"), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=os.path.dirname(script_path), timeout=total_timeout / 1000 + 5,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except subprocess.TimeoutExpired as error:
        completed = decode_node_result(error.stdout, error.stderr, -1, validate, log)
        # Integrity proves complete receipt, not that the script passed validation.
        if completed and completed.get("verifiedTextHash"):
            return completed
        known_attempts = completed.get("attempts") if completed else None
        detail = f": {completed['error']}" if completed and completed.get("error") else ""
        return {"ok": False, "error": f"Node text owner exceeded its deadline{detail}",
                "processOutcome": "unknown", "attempts": known_attempts or [{
            "provider": "node-text-generator", "status": "outcome_unknown", "error": str(error)
        }]}
    except OSError as error:
        log(f"[WARNING] Node text bootstrap failed: {error}")
        return None

    return decode_node_result(result.stdout, result.stderr, result.returncode, validate, log)


def decode_node_result(stdout, stderr, returncode, validate, log):
    stderr = stderr.decode("utf-8", errors="replace") if isinstance(stderr, bytes) else (stderr or "")
    text = stdout.decode("utf-8", errors="replace") if isinstance(stdout, bytes) else (stdout or "")
    text = text.strip().lstrip("\ufeff")
    metadata = {}
    failure = {"error": "Node returned no valid comic script", "attempts": []}
    owned = False
    for line in stderr.splitlines():
        for marker in ("TEXT_GENERATION_STARTED", "TEXT_GENERATION_META", "TEXT_GENERATION_ERROR"):
            prefix = f"[[{marker}]] "
            if not line.startswith(prefix):
                continue
            owned = True
            try:
                payload = json.loads(line[len(prefix):])
                if not isinstance(payload, dict):
                    continue
                if marker == "TEXT_GENERATION_META":
                    metadata = payload
                elif marker == "TEXT_GENERATION_ERROR":
                    failure = payload
            except ValueError:
                log(f"[WARNING] Invalid Node metadata: {marker}")
    expected_hash = metadata.get("textSha256")
    verified_hash = bool(expected_hash) and expected_hash == hashlib.sha256(text.encode("utf-8")).hexdigest()
    if expected_hash and not verified_hash:
        return {"ok": False, "error": "Node text result hash mismatch", "attempts": metadata.get("attempts") or []}
    if (returncode == 0 or verified_hash) and validate(text):
        return {"ok": True, "text": text, "metadata": metadata, "verifiedTextHash": verified_hash}
    if owned:
        return {**failure, "ok": False, "verifiedTextHash": verified_hash,
                "attempts": failure.get("attempts") or metadata.get("attempts") or []}
    log(f"[WARNING] Node failed before request ownership: exit={returncode}")
    return None
