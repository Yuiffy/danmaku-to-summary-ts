#!/usr/bin/env python
"""Move registered historical clips between Bilibili collection seasons.

The Bilibili UI exposes the user-facing season ID, while the episode APIs use
the child section ID.  A cross-season move is a delete-then-add operation;
``--apply`` is therefore required and the script only deletes episodes found
in the configured source section.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

import requests

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REGISTRY = PROJECT_ROOT / "data" / "runtime" / "clip_upload_registry.json"
SOURCE_SECTION_ID = 9482593
DEFAULT_DELAY_SECONDS = 0.4

sys.path.insert(0, str(PROJECT_ROOT / "src" / "scripts"))
from bilibili_upload import (  # noqa: E402
    add_episode_to_section,
    build_credential,
    delete_episode_from_section,
    get_collection_section_id,
)
from config_loader import find_secrets_path, get_config  # noqa: E402


def load_cookie() -> str:
    with open(find_secrets_path(), "r", encoding="utf-8-sig") as handle:
        return str((json.load(handle).get("bilibili") or {}).get("cookie") or "")


def api_headers(cookie: str) -> dict:
    return {
        "accept": "application/json, text/plain, */*",
        "cookie": cookie,
        "origin": "https://member.bilibili.com",
        "referer": "https://member.bilibili.com/platform/upload-manager",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0 Safari/537.36",
    }


def fetch_section_episodes(section_id: int, cookie: str) -> list[dict]:
    response = requests.get(
        "https://member.bilibili.com/x2/creative/web/season/section",
        params={"id": int(section_id)},
        headers=api_headers(cookie),
        timeout=45,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("code") != 0:
        raise RuntimeError(
            f"section {section_id} query failed: code={payload.get('code')} message={payload.get('message', '')}"
        )
    return list((payload.get("data") or {}).get("episodes") or [])


def extract_room_id(clip: dict) -> Optional[str]:
    text = " ".join(str(clip.get(key) or "") for key in ("mediaPath", "reviewPath", "source"))
    match = re.search(r"(?:录制-|\\|/)(\d{5,})[-_]", text)
    return match.group(1) if match else None


def upload_state(clip: dict) -> dict:
    state = clip.get("uploadState")
    return state if isinstance(state, dict) else {}


def clip_bvid(clip: dict) -> str:
    return str(upload_state(clip).get("bvid") or clip.get("bvid") or "").strip()


def clip_aid(clip: dict) -> Optional[int]:
    value = upload_state(clip).get("aid") or clip.get("aid")
    try:
        return int(value) if value else None
    except (TypeError, ValueError):
        return None


def clip_cid(clip: dict) -> Optional[int]:
    value = upload_state(clip).get("cid") or clip.get("cid")
    try:
        return int(value) if value else None
    except (TypeError, ValueError):
        return None


def classify_target(clip: dict, config: dict) -> Optional[int]:
    return get_collection_section_id(
        config,
        room_id=extract_room_id(clip),
        source_desc=clip.get("source"),
        title=f"{clip.get('prefix', '')}{clip.get('title', '')}",
        prefix=clip.get("prefix"),
    )


def index_episodes(episodes: Iterable[dict]) -> tuple[dict, dict]:
    by_aid: dict = {}
    by_bvid: dict = {}
    for episode in episodes:
        aid = episode.get("aid")
        bvid = str(episode.get("bvid") or "").strip()
        if aid not in (None, ""):
            by_aid[str(aid)] = episode
        if bvid:
            by_bvid[bvid] = episode
    return by_aid, by_bvid


def iter_candidates(registry: dict, config: dict, source_section_id: int, old_episodes: list[dict]) -> list[dict]:
    old_by_aid, old_by_bvid = index_episodes(old_episodes)
    candidates = []
    for clip_id, clip in (registry.get("clips") or {}).items():
        if not isinstance(clip, dict):
            continue
        bvid = clip_bvid(clip)
        if not bvid:
            continue
        target_section = classify_target(clip, config)
        if not target_section or int(target_section) == int(source_section_id):
            continue
        aid = clip_aid(clip)
        source_episode = old_by_aid.get(str(aid)) if aid else None
        source_episode = source_episode or old_by_bvid.get(bvid)
        if not source_episode:
            continue
        cid = source_episode.get("cid") or clip_cid(clip)
        if not cid:
            print(f"[WARN] clip #{clip_id} has no cid; skipped")
            continue
        candidates.append(
            {
                "clipId": int(clip_id),
                "clip": clip,
                "bvid": bvid,
                "aid": int(source_episode.get("aid") or aid),
                "cid": int(cid),
                "title": source_episode.get("title") or f"{clip.get('prefix', '')}{clip.get('title', '')}",
                "episodeId": int(source_episode["id"]),
                "sourceSectionId": int(source_section_id),
                "targetSectionId": int(target_section),
            }
        )
    return candidates


def update_registry_clip(clip: dict, target_section_id: int, status: str, error: str = "") -> None:
    state = clip.setdefault("uploadState", {})
    state["collectionSectionId"] = int(target_section_id)
    state["collectionStatus"] = status
    if error:
        state["collectionError"] = error
    else:
        state.pop("collectionError", None)
    state.pop("collectionApiResponse", None)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="迁移历史切片到按主播划分的 B 站合集")
    parser.add_argument("--registry", default=str(DEFAULT_REGISTRY), help="clip_upload_registry.json 路径")
    parser.add_argument("--source-section", type=int, default=SOURCE_SECTION_ID, help="当前旧合集的 section_id")
    parser.add_argument("--ids", default="", help="只处理指定 registry clip ID，逗号分隔")
    parser.add_argument("--limit", type=int, default=0, help="最多处理多少条，0 表示全部")
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY_SECONDS, help="每条迁移之间的等待秒数")
    parser.add_argument("--summary-only", action="store_true", help="只输出数量，不逐条打印标题")
    parser.add_argument("--apply", action="store_true", help="实际删除旧合集 episode 并加入目标合集")
    args = parser.parse_args(argv)

    registry_path = Path(args.registry).expanduser().resolve()
    if not registry_path.exists():
        print(f"[ERROR] registry not found: {registry_path}", file=sys.stderr)
        return 2
    registry = json.loads(registry_path.read_text(encoding="utf-8-sig"))
    config = get_config()
    cookie = load_cookie()

    print(f"[INFO] 查询旧合集 section_id={args.source_section} ...")
    old_episodes = fetch_section_episodes(args.source_section, cookie)
    candidates = iter_candidates(registry, config, args.source_section, old_episodes)
    if args.ids:
        wanted = {int(value.strip()) for value in args.ids.split(",") if value.strip()}
        candidates = [item for item in candidates if item["clipId"] in wanted]
    if args.limit > 0:
        candidates = candidates[: args.limit]

    by_target: dict[int, int] = {}
    for item in candidates:
        by_target[item["targetSectionId"]] = by_target.get(item["targetSectionId"], 0) + 1
    print(f"[INFO] 找到可迁移历史切片: {len(candidates)} 条; 目标合集: {by_target or '-'}")
    if not args.summary_only:
        for item in candidates:
            print(
                f"  #{item['clipId']} {item['bvid']} {item['sourceSectionId']} -> {item['targetSectionId']} "
                f"{item['title'][:70]}"
            )
    if not args.apply or not candidates:
        print("[DRY-RUN] 未修改 B 站；使用 --apply 才会执行迁移。")
        return 0

    credential = build_credential()
    success = 0
    failures = 0
    for index, item in enumerate(candidates, 1):
        print(f"[{index}/{len(candidates)}] 迁移 {item['bvid']} -> section_id={item['targetSectionId']}")
        try:
            deleted = delete_episode_from_section(item["episodeId"], credential)
            if deleted.get("code") != 0:
                raise RuntimeError(
                    f"删除旧合集失败: code={deleted.get('code')} message={deleted.get('message', '')}"
                )
            added = add_episode_to_section(
                item["targetSectionId"], item["aid"], item["cid"], item["title"], credential
            )
            if added.get("code") != 0:
                raise RuntimeError(
                    f"加入新合集失败（旧合集已移除）: code={added.get('code')} message={added.get('message', '')}"
                )
            update_registry_clip(item["clip"], item["targetSectionId"], "ok")
            success += 1
            print("  [OK]")
        except Exception as error:
            failures += 1
            update_registry_clip(item["clip"], item["targetSectionId"], "failed", str(error)[:300])
            print(f"  [WARN] {error}")
        # Keep the local registry resumable if the worker is interrupted.
        registry_path.write_text(
            json.dumps(registry, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        if index < len(candidates) and args.delay > 0:
            time.sleep(args.delay)

    registry_path.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[DONE] 成功 {success}，失败 {failures}；registry 已记录结果。")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
