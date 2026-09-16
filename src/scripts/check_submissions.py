#!/usr/bin/env python
"""查询B站稿件列表，确认哪些切片已上传成功"""
import sys
import os
import json
import asyncio

project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(project_root, 'src', 'scripts'))

from config_loader import find_secrets_path
from bilibili_api import Credential, video_uploader

ACCOUNT_MID = 412141275

def build_credential():
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
    return Credential(
        sessdata=cookies.get('SESSDATA', ''),
        bili_jct=cookies.get('bili_jct', ''),
        buvid3=cookies.get('buvid3', ''),
        dedeuserid=cookies.get('DedeUserID', str(ACCOUNT_MID)),
        ac_time_value=cookies.get('ac_time_value', ''),
    )

async def main():
    cred = build_credential()
    # 获取稿件列表
    from bilibili_api import user
    u = user.User(ACCOUNT_MID, credential=cred)
    
    # 获取投稿视频列表
    page = 1
    page_size = 30
    videos = []
    while True:
        result = await u.get_videos(pn=page, ps=page_size)
        vlist = result.get('list', {}).get('vlist', [])
        if not vlist:
            break
        videos.extend(vlist)
        total = result.get('page', {}).get('count', 0)
        if len(videos) >= total:
            break
        page += 1
    
    print(f"共 {len(videos)} 个稿件\n")
    # 只显示最近的（今天上传的）
    recent = [v for v in videos if v.get('created', 0) > 1750000000]  # 大致2025年7月后
    # 实际上我们看最近20个
    recent = videos[:20]
    for v in recent:
        title = v.get('title', '')
        bvid = v.get('bvid', '')
        created = v.get('created', 0)
        # 过滤含【小岁】的
        if '小岁' in title or '悠哉' in title:
            print(f"  {bvid} | {title}")

asyncio.run(main())
