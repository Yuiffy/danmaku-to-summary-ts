#!/usr/bin/env python
"""Update a Bilibili video's cover.

This uses bilibili_api's VideoEditor submit path, but avoids the current
VideoEditor.start() cover bug where upload_cover() returns a string while
_change_cover() expects a dict.
"""

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Optional

import requests
from bilibili_api import Credential, video
from bilibili_api.utils.picture import Picture
from bilibili_api.video_uploader import VideoEditor, upload_cover


DEFAULT_BVID = "BV1ytLR6vEtQ"
DEFAULT_COVER_GLOB = (
    r"D:\files\videos\DDTV*\25788785_*SUI\2026_06_17"
    r"\own_stream_fun_clips\cover_19_v2.jpg"
)
SECRET = r"D:\workspace\myrepo\danmaku-to-summary-ts\config\secret.json"


def parse_cookie(cookie_str: str) -> dict[str, str]:
    cookies = {}
    for item in cookie_str.split(";"):
        item = item.strip()
        if "=" in item:
            key, value = item.split("=", 1)
            cookies[key.strip()] = value.strip()
    return cookies


def build_credential(cookies: dict[str, str]) -> Credential:
    return Credential(
        sessdata=cookies.get("SESSDATA", ""),
        bili_jct=cookies.get("bili_jct", ""),
        buvid3=cookies.get("buvid3", ""),
        dedeuserid=cookies.get("DedeUserID", ""),
        ac_time_value=cookies.get("ac_time_value", ""),
    )


def normalize_cover_url(url: str) -> str:
    if url.startswith("//"):
        url = "https:" + url
    elif url.startswith("http://"):
        url = "https://" + url[len("http://") :]
    elif not url.startswith("https://"):
        url = "https://" + url.lstrip("/")

    # The edit API rejects hive.biliimg.com as an external link, even for the
    # same uploaded archive hash. The cover upload API returns archive.biliimg.com.
    return url.replace("https://hive.biliimg.com/bfs/archive/", "https://archive.biliimg.com/bfs/archive/")


def resolve_cover_path(path_or_glob: str) -> str:
    path = Path(path_or_glob)
    if path.exists():
        return str(path)

    matches = list(Path().glob(path_or_glob)) if not Path(path_or_glob).is_absolute() else []
    if not matches:
        drive, rest = os.path.splitdrive(path_or_glob)
        root = Path(drive + "\\") if drive else Path(".")
        matches = list(root.glob(rest.lstrip("\\/")))
    if not matches:
        raise FileNotFoundError(path_or_glob)
    return str(matches[0])


def load_auth(secret_path: str) -> tuple[str, Credential]:
    with open(secret_path, "r", encoding="utf-8-sig") as f:
        cookie_str = json.load(f)["bilibili"]["cookie"]
    return cookie_str, build_credential(parse_cookie(cookie_str))


def fetch_archive(cookie_str: str, bvid: str) -> dict:
    response = requests.get(
        "https://member.bilibili.com/x/vupre/web/archive/view",
        params={"bvid": bvid, "topic_grey": 1},
        headers={
            "User-Agent": "Mozilla/5.0",
            "Cookie": cookie_str,
            "Referer": "https://member.bilibili.com",
        },
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    if data.get("code") != 0:
        raise RuntimeError(data)
    return data["data"]


async def submit_cover(
    bvid: str,
    credential: Credential,
    archive: dict,
    cover_url: str,
) -> None:
    meta = {
        "title": archive.get("title", ""),
        "copyright": archive.get("copyright", 2),
        "source": archive.get("source", ""),
        "tag": archive.get("tag", ""),
        "desc_format_id": archive.get("desc_format_id", 9999),
        "desc": archive.get("desc", ""),
        "dynamic": archive.get("dynamic", "") or "",
        "interactive": 0,
        "new_web_edit": 1,
        "act_reserve_create": 0,
        "origin_state": 0,
        "open_elec": 0,
        "handle_staff": False,
        "topic_grey": 1,
        "no_reprint": archive.get("no_reprint", 0),
        "up_close_danmu": False,
        "up_close_reply": False,
        "up_selection_reply": False,
        "subtitles": {"lan": "", "open": 0},
        "web_os": 2,
    }

    editor = VideoEditor(bvid=bvid, meta=meta, cover="", credential=credential)
    await editor._fetch_configs()
    old_configs = editor._VideoEditor__old_configs
    old_archive = old_configs["archive"]

    videos = []
    for index, old_video in enumerate(old_configs.get("videos", [])):
        cid = old_video.get("cid")
        if not cid:
            cid = await video.Video(bvid=bvid, credential=credential).get_cid(index)
        videos.append(
            {
                "title": old_video.get("title", archive.get("title", "")),
                "desc": old_video.get("desc", ""),
                "filename": old_video.get("filename", ""),
                "cid": cid,
            }
        )

    editor.meta.update(
        {
            "tid": old_archive.get("tid", archive.get("tid", 21)),
            "cover": cover_url,
            "videos": videos,
        }
    )
    await editor._submit()


async def update_cover(
    bvid: str,
    cover_path: Optional[str],
    cover_url: Optional[str],
    secret_path: str,
) -> None:
    cookie_str, credential = load_auth(secret_path)
    before = fetch_archive(cookie_str, bvid)["archive"]
    print(f"[before] cover: {before.get('cover')}")

    if cover_url:
        submitted_url = normalize_cover_url(cover_url)
    else:
        resolved_cover = resolve_cover_path(cover_path or DEFAULT_COVER_GLOB)
        print(f"[upload] cover file: {resolved_cover}")
        submitted_url = normalize_cover_url(
            await upload_cover(Picture.from_file(resolved_cover), credential)
        )

    print(f"[submit] cover: {submitted_url}")
    await submit_cover(bvid, credential, before, submitted_url)

    after = fetch_archive(cookie_str, bvid)["archive"]
    print(f"[after] cover: {after.get('cover')}")
    print(f"[after] state: {after.get('state_desc')}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Update Bilibili video cover")
    parser.add_argument("--bvid", default=DEFAULT_BVID)
    parser.add_argument("--cover", default=DEFAULT_COVER_GLOB)
    parser.add_argument("--cover-url", help="Reuse an already-uploaded cover URL")
    parser.add_argument("--secret", default=SECRET)
    args = parser.parse_args()

    asyncio.run(update_cover(args.bvid, args.cover, args.cover_url, args.secret))


if __name__ == "__main__":
    main()
