#!/usr/bin/env python
"""Follow the four 2026 VirtuaReal newcomers and join their fan clubs."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from bilibili_api import Credential, live, user
from bilibili_api.user import RelationType


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SECRET_PATH = PROJECT_ROOT / "config" / "secret.json"
FAN_CLUB_GIFT_ID = 31164
FAN_CLUB_GIFT_PRICE = 100

TARGETS = (
    {"name": "羽啾chu2u", "uid": 2138961136, "room_id": 1727074031},
    {"name": "枝堇Sumire", "uid": 1150976664, "room_id": 1727076670},
    {"name": "小松绿Viridis", "uid": 1891335475, "room_id": 1727071052},
    {"name": "四时小路Komichi", "uid": 1512246445, "room_id": 1700301235},
)


def load_credential() -> tuple[Credential, int]:
    secrets = json.loads(SECRET_PATH.read_text(encoding="utf-8-sig"))
    cookie_text = secrets.get("bilibili", {}).get("cookie", "")
    cookies: dict[str, str] = {}
    for item in cookie_text.split(";"):
        if "=" not in item:
            continue
        key, value = item.strip().split("=", 1)
        cookies[key] = value

    missing = [
        key for key in ("SESSDATA", "bili_jct", "DedeUserID") if not cookies.get(key)
    ]
    if missing:
        raise RuntimeError(f"Bilibili cookie is missing: {', '.join(missing)}")

    credential = Credential(
        sessdata=cookies.get("SESSDATA"),
        bili_jct=cookies.get("bili_jct"),
        buvid3=cookies.get("buvid3"),
        buvid4=cookies.get("buvid4"),
        dedeuserid=cookies.get("DedeUserID"),
        ac_time_value=cookies.get("ac_time_value"),
    )
    return credential, int(cookies["DedeUserID"])


def is_following(relation: dict[str, Any]) -> bool:
    attribute = relation.get("relation", {}).get("attribute", 0)
    return isinstance(attribute, int) and bool(attribute & 2)


def find_medal(medal_wall: dict[str, Any], target_uid: int) -> dict[str, Any] | None:
    for item in medal_wall.get("list", []):
        medal = item.get("medal_info", {}) if isinstance(item, dict) else {}
        if medal.get("target_id") == target_uid:
            return {
                "name": medal.get("medal_name"),
                "level": medal.get("level"),
                "is_lit": item.get("uinfo_medal", {}).get("is_light") == 1,
            }
    return None


def error_text(error: Exception) -> str:
    return f"{type(error).__name__}: {error}"[:300]


async def process_target(
    target: dict[str, Any], credential: Credential, own_uid: int, execute: bool
) -> dict[str, Any]:
    uid = int(target["uid"])
    room_id = int(target["room_id"])
    account = user.User(uid, credential=credential)
    medal_owner = user.User(own_uid, credential=credential)
    room = live.LiveRoom(room_id, credential=credential)
    result: dict[str, Any] = dict(target)

    try:
        relation_before = await account.get_relation()
        followed_before = is_following(relation_before)
        result["followed_before"] = followed_before
        if followed_before:
            result["follow"] = "already_following"
        elif not execute:
            result["follow"] = "would_follow"
        else:
            await account.modify_relation(RelationType.SUBSCRIBE)
            result["follow"] = "followed"
    except Exception as error:
        result["follow"] = "failed"
        result["follow_error"] = error_text(error)

    medal_before: dict[str, Any] | None = None
    try:
        medal_wall_before = await medal_owner.get_user_medal()
        medal_before = find_medal(medal_wall_before, uid)
        result["medal_before"] = medal_before
    except Exception as error:
        result["medal_check"] = "failed"
        result["medal_check_error"] = error_text(error)

    if medal_before is not None:
        result["gift"] = "skipped_existing_medal"
    elif not execute:
        result["gift"] = "would_send"
    else:
        try:
            await room.send_gift_gold(
                uid=own_uid,
                gift_id=FAN_CLUB_GIFT_ID,
                gift_num=1,
                price=FAN_CLUB_GIFT_PRICE,
            )
            result["gift"] = "sent"
        except Exception as error:
            result["gift"] = "failed"
            result["gift_error"] = error_text(error)

    if execute and result.get("gift") in {"sent", "skipped_existing_medal"}:
        try:
            medal_wall_after = await medal_owner.get_user_medal()
            result["medal_after"] = find_medal(medal_wall_after, uid)
        except Exception as error:
            result["medal_verify"] = "failed"
            result["medal_verify_error"] = error_text(error)

    return result


async def run(execute: bool) -> list[dict[str, Any]]:
    credential, own_uid = load_credential()
    results = []
    for target in TARGETS:
        results.append(await process_target(target, credential, own_uid, execute))
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="perform follows and send one 0.1 RMB fan-club gift per eligible target",
    )
    args = parser.parse_args()
    results = asyncio.run(run(args.execute))
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
