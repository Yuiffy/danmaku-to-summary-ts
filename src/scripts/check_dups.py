#!/usr/bin/env python
"""Check for duplicate submissions."""
import asyncio
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bilibili_upload import build_credential
from bilibili_api import user

async def main():
    cred = build_credential()
    u = user.User(412141275, credential=cred)
    page = 1
    videos = []
    while True:
        res = await u.get_videos(pn=page, ps=30)
        vlist = res.get('list', {}).get('vlist', [])
        if not vlist:
            break
        videos.extend(vlist)
        if page >= 3:
            break
        page += 1
    # Only show recent ones (today)
    for v in videos:
        created = v.get('created', 0)
        if created >= 1783014000:  # roughly today's batch
            title = v.get('title', '')
            bvid = v.get('bvid', '')
            print(f'{bvid}  {created}  {title}')
    print(f'---')

asyncio.run(main())
