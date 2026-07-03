#!/usr/bin/env python
"""Check existing submissions to avoid duplicates."""
import asyncio
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
    for v in videos:
        title = v.get('title', '')[:80]
        bvid = v.get('bvid', '')
        created = v.get('created', '')
        print(f'{bvid}  {created}  {title}')
    print(f'Total fetched: {len(videos)}')

asyncio.run(main())
