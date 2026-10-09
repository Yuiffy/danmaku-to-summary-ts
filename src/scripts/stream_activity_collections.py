"""Inspect or create the dedicated Sui singing and synchronous-viewing collections."""
from __future__ import annotations
import argparse
import json
import time
from pathlib import Path
import requests

try:
    from .bilibili_upload import build_credential, list_collection_seasons, create_collection_season
except ImportError:
    from bilibili_upload import build_credential, list_collection_seasons, create_collection_season

COLLECTIONS = {
    "songs": {"title": "岁己歌切", "description": "岁己SUI直播歌切。每场直播按演唱顺序分P收录。"},
    "watch": {"title": "岁己同步视听", "description": "岁己SUI直播同步视听。按场次收录，连续观看内容按约25分钟分P。"},
}


def collection_row(rows, title):
    matches = [row for row in rows if (row.get("season") or row).get("title") == title]
    if len(matches) > 1:
        raise ValueError(f"duplicate collection title: {title}")
    if not matches:
        return None
    row = matches[0]
    season = row.get("season") or row
    sections = row.get("sections") or []
    if isinstance(sections, dict):
        sections = sections.get("sections") or []
    if not sections or not sections[0].get("id") or not season.get("id"):
        raise ValueError(f"collection has no section: {title}")
    return {"title": title, "seasonId": int(season["id"]), "sectionId": int(sections[0]["id"])}


def ensure_collections(credential, apply=False, cover=None):
    rows = list_collection_seasons(credential)
    if cover is None:
        cover = next(((row.get("season") or row).get("cover") for row in rows
                      if str((row.get("season") or row).get("title", "")).startswith("岁己AI自动切片")), None)
    result = {}
    for key, spec in COLLECTIONS.items():
        found = collection_row(rows, spec["title"])
        if not found and apply:
            if not isinstance(cover, str) or not cover.startswith(("https://", "http://")):
                raise ValueError("a valid Sui collection cover is required")
            try:
                season_id = create_collection_season(spec["title"], spec["description"], cover, credential)
            except requests.RequestException:
                # Re-read an uncertain write before considering another creation.
                rows = list_collection_seasons(credential)
                found = collection_row(rows, spec["title"])
                if not found:
                    raise
                season_id = found["seasonId"]
            for attempt in range(4):
                rows = list_collection_seasons(credential)
                found = collection_row(rows, spec["title"])
                if found and found["seasonId"] == season_id:
                    break
                if attempt < 3:
                    time.sleep(2)
            if not found:
                raise ValueError(f"collection created (season={season_id}) but section is not yet visible")
        result[key] = found or {"title": spec["title"], "status": "missing"}
    if result["songs"].get("sectionId") and result["songs"].get("sectionId") == result["watch"].get("sectionId"):
        raise ValueError("singing and viewing need different collections")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="create missing collections (reuses exact existing names)")
    parser.add_argument("--state", help="optional local result JSON path")
    args = parser.parse_args()
    result = ensure_collections(build_credential(), apply=args.apply)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.state:
        Path(args.state).write_text(text + "\n", encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
