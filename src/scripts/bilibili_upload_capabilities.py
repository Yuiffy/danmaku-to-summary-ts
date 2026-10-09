"""Read current account upload permissions from the official web uploader APIs."""
from __future__ import annotations
import argparse
import json
import sys
import time
from pathlib import Path
import requests
try:
    from .check_archives import load_cookie
except ImportError:
    from check_archives import load_cookie


def fetch_capabilities(cookie, get=requests.get):
    headers = {"Cookie": cookie, "User-Agent": "Mozilla/5.0", "Referer": "https://member.bilibili.com/video/upload.html"}
    payloads = {}
    # The actual video uploader uses archive/white. The creator platform's
    # /white can return a different have_permission_of_p value for this account.
    for key, endpoint in (("permissions", "archive/white"), ("pre", "archive/pre")):
        response = get("https://member.bilibili.com/x/vupre/web/" + endpoint, headers=headers, timeout=25)
        response.raise_for_status()
        payload = response.json()
        if payload.get("code") != 0 or not isinstance(payload.get("data"), dict):
            raise ValueError(f"upload capabilities {key} failed: {payload.get('code')}")
        payloads[key] = payload["data"]
    permissions, info = payloads["permissions"], payloads["pre"].get("myinfo") or {}
    if "have_permission_of_p" not in permissions:
        raise ValueError("multipart permission is unknown")
    limits = permissions.get("new_web_edit") or {}
    max_parts = limits.get("max_count", 200)
    max_parts_per_add = limits.get("single_max_count", 100)
    if any(type(value) is not int or value < 1 for value in (max_parts, max_parts_per_add)):
        raise ValueError("multipart limits are unknown")
    max_gib = 8
    for key, size in (("4-8", 8), ("8-16", 16), ("16-32", 32), ("32-64", 64)):
        if (info.get("uploadsize") or {}).get(key) is True:
            max_gib = size
    return {"version": 1, "checkedAt": int(time.time()), "accountId": info.get("mid"), "uploadChannel": "web",
            "multipartAllowed": permissions["have_permission_of_p"] is True,
            "maxParts": max_parts if permissions["have_permission_of_p"] is True else 1,
            "maxPartsPerAdd": max_parts_per_add,
            "collectionAllowed": permissions.get("season") is True,
            "multipartCollectionAllowed": permissions.get("season_add_multip") is True,
            "externalSubtitlesAllowed": info.get("subtitle") is True,
            "maxFileBytes": max_gib * 1024 ** 3,
            "maxVideoSeconds": 36000 if (info.get("uploadduration") or {}).get("3-10") is True else 10800,
            "evidence": {"permissionField": "have_permission_of_p", "permissionEndpoint": "archive/white",
                         "multipartCollectionField": "season_add_multip", "new_web_edit": limits,
                         "uploadsize": info.get("uploadsize"),
                         "uploadduration": info.get("uploadduration"), "apiBase": "https://member.bilibili.com/x/vupre/web/"}}


def validate_upload_parts(parts, require_subtitles=False):
    """Check a whole reviewed bundle without splitting it into separate submissions."""
    current = fetch_capabilities(load_cookie())
    if len(parts) > current['maxParts']:
        raise ValueError(f"multipart permission unavailable: this bundle has {len(parts)} Ps, "
                         f"current account permits {current['maxParts']}; the bundle is preserved")
    if len(parts) > 1 and not current['multipartCollectionAllowed']:
        raise ValueError("multipart collection permission unavailable; the reviewed bundle is preserved")
    if ((require_subtitles and not current['externalSubtitlesAllowed']) or not current['collectionAllowed']
            or any(Path(p['mediaPath']).stat().st_size > current['maxFileBytes']
                   or p['actualDuration'] > current['maxVideoSeconds'] for p in parts)):
        raise ValueError('reviewed multipart submission exceeds current account permissions or file limits')
    return current


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state")
    parser.add_argument("--metadata", help="Preflight one rendered activity/game package before enqueueing")
    args = parser.parse_args()
    if args.metadata:
        metadata = json.loads(Path(args.metadata).read_text(encoding="utf-8-sig"))
        try:
            result = validate_upload_parts(metadata["output"]["parts"], metadata.get("externalSubtitles") is True)
        except ValueError as error:
            print(f"[BLOCKED] {error}", file=sys.stderr)
            sys.exit(2)
    else:
        result = fetch_capabilities(load_cookie())
    if args.state:
        p = Path(args.state); p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
