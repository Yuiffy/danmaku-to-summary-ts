"""Check all recent submissions via member API - try different approach"""
import json
import requests
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src", "scripts"))
from update_cover import load_auth, fetch_archive

SECRET = os.path.join(os.path.dirname(__file__), "..", "..", "config", "secret.json")
SECRET = os.path.abspath(SECRET)

cookie_str, cred = load_auth(SECRET)

# Use the member.bilibili.com API with proper params
resp = requests.get(
    "https://member.bilibili.com/x/vupre/web/archives",
    params={"mid": 412141275, "pn": 1, "ps": 50, "order": "pubdate", "topic_grey": 1},
    headers={
        "User-Agent": "Mozilla/5.0",
        "Cookie": cookie_str,
        "Referer": "https://member.bilibili.com/platform/upload-manager/article",
    },
    timeout=30,
)
data = resp.json()
print(f"code: {data.get('code')}, message: {data.get('message', '')}")

d = data.get("data", {})
if isinstance(d, dict):
    arcs = d.get("archives") or d.get("arc_audits") or []
    print(f"archives count: {len(arcs) if arcs else 0}")
    if arcs:
        for a in arcs[:30]:
            if isinstance(a, dict):
                arc = a.get("Archive", a) if "Archive" in a else a
                title = arc.get("title", "")
                bvid = arc.get("bvid", "")
                state = arc.get("state", 0)
                print(f"  {bvid} | state={state} | {title}")
