"""Deliver external game subtitles after CID creation; never submit another video."""
from __future__ import annotations
import argparse
import asyncio
import hashlib
import json
import os
import re
import time
from pathlib import Path
import requests
from bilibili_api import video
from bilibili_api.utils.network import Api
try:
    from .audit_bilibili_clip import parse_srt
    from .bilibili_upload import build_credential
    from .check_archives import load_cookie
    from .stream_game_review import validate_game_review
except ImportError:
    from audit_bilibili_clip import parse_srt
    from bilibili_upload import build_credential
    from check_archives import load_cookie
    from stream_game_review import validate_game_review

TASK_ROOT = Path(__file__).resolve().parents[2] / "data/runtime/game_subtitle_tasks"
TRANSIENT_SUBTITLE_REJECTIONS = frozenset({79022})  # Archive exists in creator center but is not yet visible to subtitle API.


async def submit_platform_subtitle(instance, credential, language, payload, cid):
    # Current official language catalog uses zh; older SDK catalogs reject it locally.
    api = video.API["operate"]["submit_subtitle"]
    return await Api(**api, credential=credential).update_data(type=1, oid=cid, lan=language,
        data=json.dumps(payload, ensure_ascii=False), submit=True, sign=False, bvid=instance.get_bvid()).result


def atomic_json(path, data):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def acquire_task_lock(path):
    """An OS lock is released on process exit, including a crashed worker."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    handle.seek(0, 2)
    if not handle.tell():
        handle.write(b"0"); handle.flush()
    handle.seek(0)
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close(); return None
    return handle


def subtitle_payload(path, duration):
    cues = parse_srt(path)
    if not cues or any(c["start"] < 0 or c["end"] <= c["start"] or c["end"] > duration + .03 for c in cues):
        raise ValueError("external SRT exceeds this P's media timeline")
    return {"font_size": .4, "font_color": "#FFFFFF", "background_alpha": .5,
            "background_color": "#9C27B0", "Stroke": "none",
            "body": [{"from": c["start"], "to": c["end"], "location": 2, "content": c["text"]} for c in cues]}


def payload_digest(payload):
    body = [{"fromMs": round(float(c["from"]) * 1000), "toMs": round(float(c["to"]) * 1000),
             "location": c.get("location", 2), "content": c["content"]} for c in payload["body"]]
    return hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


async def confirm_visible_subtitle(instance, language, cid, digest):
    """Only a matching published payload confirms a lost POST response."""
    info = await instance.get_subtitle(cid=cid)
    for row in (info or {}).get("subtitles") or []:
        if row.get("lan") != language or not row.get("subtitle_url"):
            continue
        url = row["subtitle_url"]
        if url.startswith("//"):
            url = "https:" + url
        response = requests.get(url, timeout=25)
        response.raise_for_status()
        if payload_digest(response.json()) == digest:
            return {"subtitle_id": row.get("id"), "confirmedBy": "matching_online_payload"}
    return None


def archive_pages(cookie, bvid, get=requests.get):
    response = get("https://member.bilibili.com/x/vupre/web/archive/view", params={"bvid": bvid, "topic_grey": 1},
                   headers={"Cookie": cookie, "User-Agent": "Mozilla/5.0", "Referer": "https://member.bilibili.com/"}, timeout=25)
    response.raise_for_status()
    data = response.json()
    if data.get("code") != 0:
        return []
    return (data.get("data") or {}).get("videos") or []


def bind_pages(parts, online, submission_title=None):
    if not online or any(not row.get("cid") for row in online):
        return None
    if len(parts) != len(online):
        raise ValueError("online P count differs from the reviewed game submission")
    bindings = []
    for part, row in zip(parts, online):
        titles = {part["title"].strip()}
        if len(parts) == 1 and submission_title:
            titles.add(submission_title.strip())
        if str(row.get("title") or "").strip() not in titles:
            raise ValueError("online P order/title differs; do not attach subtitles to a guessed CID")
        if row.get("duration") and abs(float(row["duration"]) - part["actualDuration"]) > 2:
            raise ValueError("online P duration differs from the reviewed game media")
        bindings.append((part, int(row["cid"])))
    return bindings


def register_task(clip, result, task_root=TASK_ROOT):
    if not clip.get("externalSubtitles") or not result.get("bvid"):
        return None
    bvid = result["bvid"]
    if not re.fullmatch(r"BV[A-Za-z0-9]{10}", bvid):
        raise ValueError("invalid subtitle task BV")
    metadata_path = str(Path(clip["metadataPath"]).resolve())
    path = Path(task_root) / (bvid + ".json")
    if path.exists():
        old = json.loads(path.read_text(encoding="utf-8-sig"))
        if old.get("metadataPath") != metadata_path:
            raise ValueError("this BV is already bound to another subtitle artifact")
        return path
    atomic_json(path, {"version": 1, "bvid": bvid, "metadataPath": metadata_path,
                       "status": "pending", "createdAt": int(time.time()), "pages": {}, "attempts": 0})
    return path


async def process_task(path, credential, cookie, *, fetch_pages=archive_pages, submit=None, confirm=None):
    path = Path(path)
    lock = path.with_suffix(".lock")
    handle = acquire_task_lock(lock)
    if handle is None:
        return {"subtitleStatus": "worker_busy"}
    try:
        task = json.loads(path.read_text(encoding="utf-8-sig"))
        if task.get("status") == "complete":
            return {"subtitleStatus": "complete", "subtitleTaskPath": str(path), "subtitlePages": list(task["pages"].values())}
        data = json.loads(Path(task["metadataPath"]).read_text(encoding="utf-8-sig"))
        validate_game_review(data)
        bindings = bind_pages(data["output"]["parts"], fetch_pages(cookie, task["bvid"]),
                              (data["upload"].get("prefix") or "") + data["copy"]["title"])
        if bindings is None:
            task.update(status="retry_wait", retryAt=int(time.time()) + 90, error="archive CIDs are not yet available")
            atomic_json(path, task)
            return {"subtitleStatus": "pending_archive", "subtitleTaskPath": str(path)}
        instance = None if submit else video.Video(bvid=task["bvid"], credential=credential)
        reviewed_language = data["upload"].get("subtitleLanguage") or "zh-CN"
        language = "zh" if reviewed_language == "zh-CN" else reviewed_language
        for index, (part, cid) in enumerate(bindings):
            payload = subtitle_payload(part["srtPath"], part["actualDuration"])
            digest = payload_digest(payload)
            key = str(index + 1)
            old = task["pages"].get(key) or {}
            if old:
                if old.get("cid") != cid or old.get("payloadSha256") != digest:
                    raise ValueError("subtitle task's CID or approved SRT changed")
                if old.get("status") == "rejected" and old.get("errorCode") == 79011:
                    old.setdefault("rejectedAttempts", []).append({"language": old.get("language"), "errorCode": 79011,
                        "error": old.get("error"), "confirmedRejection": True})
                    old["language"] = language
                elif old.get("language") != language:
                    raise ValueError("subtitle task language changed without a confirmed rejection")
                if old.get("status") == "rejected" and old.get("errorCode") in TRANSIENT_SUBTITLE_REJECTIONS:
                    old.setdefault("rejectedAttempts", []).append({"language": old.get("language"), "errorCode": old["errorCode"],
                        "error": old.get("error"), "confirmedRejection": True})
                if old.get("status") == "submitted":
                    continue
                if old.get("status") in ("submitting", "uncertain"):
                    found = await (confirm(language, cid, digest) if confirm else confirm_visible_subtitle(instance, language, cid, digest)) if instance or confirm else None
                    if found:
                        old.update(status="submitted", result=found, submittedAt=int(time.time()))
                        atomic_json(path, task); continue
                    # Visibility can lag. Absence is never permission to repeat a POST.
                    task.update(status="uncertain", retryAt=int(time.time()) + 300,
                                error="uncertain subtitle write is waiting for a matching online payload; POST will not repeat")
                    atomic_json(path, task)
                    return {"subtitleStatus": "uncertain", "subtitleTaskPath": str(path)}
            page = {"index": index + 1, "title": part["title"], "cid": cid, "language": language,
                    "reviewedLanguage": reviewed_language, "rejectedAttempts": old.get("rejectedAttempts") or [],
                    "srtPath": part["srtPath"], "payloadSha256": digest, "cues": len(payload["body"]), "status": "submitting"}
            task["pages"][key] = page; atomic_json(path, task)
            try:
                reply = await (submit(language, payload, cid) if submit else submit_platform_subtitle(instance, credential, language, payload, cid))
            except Exception as error:
                error_code = getattr(error, "code", None)
                page.update(status="rejected" if error_code is not None else "uncertain", error=str(error)[:300], errorCode=error_code)
                transient = error_code in TRANSIENT_SUBTITLE_REJECTIONS
                task["attempts"] = task.get("attempts", 0) + 1
                task.update(status="retry_wait" if transient else "blocked" if error_code is not None else "uncertain",
                            retryAt=int(time.time()) + min(1800, 90 * task["attempts"]) if transient else int(time.time()) + 300)
                atomic_json(path, task)
                return {"subtitleStatus": "pending_archive" if transient else task["status"], "subtitleTaskPath": str(path), "subtitleError": page["error"]}
            page.update(status="submitted", result=reply, submittedAt=int(time.time())); atomic_json(path, task)
        task.update(status="complete", completedAt=int(time.time())); task.pop("error", None); atomic_json(path, task)
        return {"subtitleStatus": "complete", "subtitleTaskPath": str(path), "subtitlePages": list(task["pages"].values())}
    except (OSError, ValueError, KeyError, TypeError, requests.RequestException) as error:
        task = json.loads(path.read_text(encoding="utf-8-sig"))
        task["attempts"] = task.get("attempts", 0) + 1
        task.update(status="retry_wait" if isinstance(error, requests.RequestException) else "blocked",
                    retryAt=int(time.time()) + min(1800, 90 * task["attempts"]), error=str(error)[:500])
        atomic_json(path, task)
        return {"subtitleStatus": task["status"], "subtitleTaskPath": str(path), "subtitleError": task["error"]}
    finally:
        handle.close()


async def after_upload(clip, result, credential, cookie):
    path = register_task(clip, result)
    if path:
        result.update(await process_task(path, credential, cookie))
    return result


async def worker(task_root=TASK_ROOT):
    credential, cookie = build_credential(), load_cookie()
    for path in sorted(Path(task_root).glob("BV*.json")):
        task = json.loads(path.read_text(encoding="utf-8-sig"))
        retryable_rejection = task.get("status") == "blocked" and any(p.get("status") == "rejected"
            and p.get("errorCode") in TRANSIENT_SUBTITLE_REJECTIONS for p in task.get("pages", {}).values())
        if task.get("status") == "complete" or (task.get("status") == "blocked" and not retryable_rejection) or task.get("retryAt", 0) > time.time():
            continue
        result = await process_task(path, credential, cookie)
        sync_registry_subtitle_result(task["bvid"], result)
        print(json.dumps({"bvid": task["bvid"], **result}, ensure_ascii=False), flush=True)


def sync_registry_subtitle_result(bvid, result):
    import clip_upload_registry as registry_api
    handle = registry_api.acquire_queue_mutation_lock()
    try:
        registry = registry_api.load_json(registry_api.REGISTRY_PATH, registry_api.default_registry())
        changed = False
        for clip in registry.get("clips", {}).values():
            if (clip.get("uploadState") or {}).get("bvid") != bvid:
                continue
            state_path = Path(clip["statePath"])
            state = registry_api.load_json(state_path, {})
            for entry in (state.get("done") or {}).values():
                if entry.get("bvid") == bvid:
                    entry.update(result)
            registry_api.save_json(state_path, state)
            clip["uploadState"].update(result); changed = True
        if changed:
            registry_api.save_json(registry_api.REGISTRY_PATH, registry)
    finally:
        registry_api.release_queue_mutation_lock(handle)


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--loop", action="store_true")
    parser.add_argument("--task-root", default=str(TASK_ROOT))
    parser.add_argument("--retry-rejected-language", metavar="BV", help="Recover a confirmed 79011 rejection using the current Chinese language code")
    args = parser.parse_args()
    if args.retry_rejected_language:
        path = Path(args.task_root) / (args.retry_rejected_language + ".json")
        handle = acquire_task_lock(path.with_suffix(".lock"))
        if handle is None:
            raise ValueError("subtitle task is busy")
        try:
            task = json.loads(path.read_text(encoding="utf-8-sig"))
            found = False
            for page in task["pages"].values():
                if page.get("status") in ("uncertain", "rejected") and (page.get("errorCode") == 79011
                    or str(page.get("error") or "").startswith("接口返回错误代码：79011，信息：不合法的语言。")):
                    page.update(status="rejected", errorCode=79011); found = True
            if not found:
                raise ValueError("no confirmed invalid-language rejection; uncertain POST must not be repeated")
            task.update(status="pending", retryAt=0); atomic_json(path, task)
        finally:
            handle.close()
    while True:
        await worker(args.task_root)
        if not args.loop:
            break
        await asyncio.sleep(30)


if __name__ == "__main__":
    asyncio.run(main())
