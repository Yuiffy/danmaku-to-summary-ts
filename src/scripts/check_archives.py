# -*- coding: utf-8 -*-
"""List existing bilibili archives to avoid duplicate uploads."""
import json, sys, requests
sys.path.insert(0, 'src/scripts')
from config_loader import find_secrets_path

secrets_path = find_secrets_path()
with open(secrets_path, 'r', encoding='utf-8-sig') as f:
    secrets = json.load(f)
cookie_str = secrets.get('bilibili', {}).get('cookie', '')

resp = requests.get(
    "https://member.bilibili.com/x/web/archives",
    params={"mid": 412141275, "pn": 1, "ps": 10, "order": "pubdate", "status": "pubed", "type": 0},
    headers={
        "User-Agent": "Mozilla/5.0",
        "Cookie": cookie_str,
        "Referer": "https://member.bilibili.com",
    },
    timeout=30,
)
data = resp.json()
print(f"code: {data.get('code')}, message: {data.get('message')}")

d = data.get("data", {})
if isinstance(d, dict):
    arcs = d.get("archives", [])
    page = d.get("page", {})
    print(f"Total: {page.get('count', '?')}, showing {len(arcs)}")
    for a in arcs:
        bvid = a.get("bvid", "")
        title = a.get("title", "")[:70]
        state = a.get("state", "")
        print(f"  {bvid} | {title} | state={state}")
else:
    print(f"data type: {type(d)}")
    print(f"Full: {json.dumps(data, ensure_ascii=False)[:800]}")
