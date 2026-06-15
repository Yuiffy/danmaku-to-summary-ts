#!/usr/bin/env python
"""检查B站稿件列表中重复的切片，标记哪些需要删除/转私密"""
import sys
import os
import json
import asyncio
from collections import defaultdict

project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(project_root, 'src', 'scripts'))

from config_loader import find_secrets_path
from bilibili_api import Credential, user

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
    u = user.User(ACCOUNT_MID, credential=cred)

    # 获取所有稿件
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

    # 筛选今天上传的【小岁】切片（含重复）
    today_clips = []
    for v in videos:
        title = v.get('title', '')
        bvid = v.get('bvid', '')
        created = v.get('created', 0)
        if '【小岁】' in title:
            today_clips.append({
                'bvid': bvid,
                'title': title,
                'created': created,
                'aid': v.get('aid', 0),
            })

    # 按标题去重，找出重复的
    title_groups = defaultdict(list)
    for clip in today_clips:
        title_groups[clip['title']].append(clip)

    print(f"共 {len(today_clips)} 个【小岁】稿件\n")

    # 列出所有重复组
    duplicates = {k: v for k, v in title_groups.items() if len(v) > 1}
    
    if not duplicates:
        print("没有发现重复稿件")
        return

    print(f"发现 {len(duplicates)} 组重复稿件：\n")
    
    to_delete = []
    for title, clips in sorted(duplicates.items()):
        print(f"📌 {title}")
        # 按时间排序，早传的保留，晚传的删除
        clips_sorted = sorted(clips, key=lambda x: x['created'])
        keeper = clips_sorted[0]
        print(f"  ✅ 保留: {keeper['bvid']} (上传时间: {keeper['created']})")
        for c in clips_sorted[1:]:
            print(f"  ❌ 删除: {c['bvid']} (上传时间: {c['created']})")
            to_delete.append(c)
        print()

    print(f"\n总计需要处理 {len(to_delete)} 个重复稿件")
    print("\n待删除列表 (bvid):")
    for c in to_delete:
        print(f"  {c['bvid']} | {c['title']}")

asyncio.run(main())
