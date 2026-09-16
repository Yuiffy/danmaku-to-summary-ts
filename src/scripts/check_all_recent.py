#!/usr/bin/env python
"""查询最近30个稿件，全部显示"""
import sys, os, json, asyncio
sys.path.insert(0, os.path.join('src', 'scripts'))
from config_loader import find_secrets_path
from bilibili_api import Credential, user

ACCOUNT_MID = 412141275

secrets_path = find_secrets_path()
with open(secrets_path, 'r', encoding='utf-8-sig') as f:
    secrets = json.load(f)
cookie_str = secrets.get('bilibili', {}).get('cookie', '')
cookies = {}
for item in cookie_str.split(';'):
    item = item.strip()
    if '=' in item:
        k, v = item.split('=', 1)
        cookies[k.strip()] = v.strip()
cred = Credential(
    sessdata=cookies.get('SESSDATA', ''),
    bili_jct=cookies.get('bili_jct', ''),
    buvid3=cookies.get('buvid3', ''),
    dedeuserid=cookies.get('DedeUserID', str(ACCOUNT_MID)),
    ac_time_value=cookies.get('ac_time_value', ''),
)

async def main():
    u = user.User(ACCOUNT_MID, credential=cred)
    page = 1
    videos = []
    while True:
        result = await u.get_videos(pn=page, ps=30)
        vlist = result.get('list', {}).get('vlist', [])
        if not vlist:
            break
        videos.extend(vlist)
        total = result.get('page', {}).get('count', 0)
        if len(videos) >= total:
            break
        page += 1
    print(f"Total: {len(videos)}")
    for v in videos[:30]:
        bvid = v.get('bvid', '')
        title = v.get('title', '')
        created = v.get('created', 0)
        print(f"{bvid} | {title} | {created}")

asyncio.run(main())
