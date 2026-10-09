"""Ensure an explicitly requested game collection without creating duplicate seasons."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import requests

try:
    from .bilibili_upload import build_credential, list_collection_seasons, create_collection_season
    from .stream_activity_collections import collection_row
except ImportError:
    from bilibili_upload import build_credential, list_collection_seasons, create_collection_season
    from stream_activity_collections import collection_row


def ensure_game_collection(credential, title, description, apply=False, cover=None):
    rows = list_collection_seasons(credential)
    found = collection_row(rows, title)
    if found:
        return found
    if not apply:
        return {"title": title, "status": "missing"}
    cover = cover or next(((row.get("season") or row).get("cover") for row in rows
                           if str((row.get("season") or row).get("title", "")).startswith("岁己AI自动切片")), None)
    if not isinstance(cover, str) or not cover.startswith(("http://", "https://")):
        raise ValueError("game collection needs an existing valid cover")
    try:
        season_id = create_collection_season(title, description, cover, credential)
    except requests.RequestException:
        # An uncertain POST can have succeeded. Never repeat it before reading.
        found = collection_row(list_collection_seasons(credential), title)
        if found:
            return found
        raise
    found = collection_row(list_collection_seasons(credential), title)
    if not found or found["seasonId"] != season_id:
        raise ValueError(f"collection created as season {season_id}; section is not yet visible, re-read later")
    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--title", required=True)
    parser.add_argument("--description", required=True)
    parser.add_argument("--cover")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--state")
    args = parser.parse_args()
    result = ensure_game_collection(build_credential(), args.title, args.description, args.apply, args.cover)
    if args.state:
        p = Path(args.state); p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
