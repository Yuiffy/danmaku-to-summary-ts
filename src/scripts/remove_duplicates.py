#!/usr/bin/env python
"""
删除/转仅自己可见 重复稿件
B站稿件管理: 通过 member.bilibili.com/x/web/Archive 接口
"""
import sys
import os
import json
import asyncio

project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(project_root, 'src', 'scripts'))

from config_loader import find_secrets_path
from bilibili_api import Credential
import httpx

ACCOUNT_MID = 412141275

# 需要处理的重复稿件 (晚传的，需要删除)
DUPLICATES_TO_REMOVE = [
    {"bvid": "BV1rJJN6YE3U", "title": "听说群友一块钱买两根雪糕", "aid": None},
    {"bvid": "BV16HJN6wEno", "title": "开播迟到搬不动水桶", "aid": None},
    {"bvid": "BV16JJN6YE6T", "title": "游泳教练朋友圈", "aid": None},
]

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

async def get_aid_from_bvid(bvid: str, credential: Credential) -> int:
    """通过bvid获取aid"""
    from bilibili_api import video
    v = video.Video(bvid=bvid, credential=credential)
    info = await v.get_info()
    return info.get('aid')

async def delete_video(bvid: str, aid: int, credential: Credential):
    """删除稿件 - 使用B站稿件管理API
    
    POST https://member.bilibili.com/x/web/archive/dql
    参数: aid
    """
    import time
    cookies = {
        'SESSDATA': credential.sessdata,
        'bili_jct': credential.bili_jct,
        'DedeUserID': credential.dedeuserid,
    }
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://member.bilibili.com/',
    }
    
    # 尝试删除接口
    url = 'https://member.bilibili.com/x/web/archive/dql'
    data = {
        'aid': aid,
        'csrf': credential.bili_jct,
    }
    
    async with httpx.AsyncClient(cookies=cookies, headers=headers, timeout=30) as client:
        resp = await client.post(url, data=data)
        result = resp.json()
        print(f"  删除结果: code={result.get('code')}, message={result.get('message', '')}")
        return result

async def main():
    cred = build_credential()
    print("[INFO] 凭证已创建\n")

    for item in DUPLICATES_TO_REMOVE:
        bvid = item['bvid']
        print(f"处理: {bvid} | {item['title']}")
        
        # 获取aid
        try:
            aid = await get_aid_from_bvid(bvid, cred)
            print(f"  aid: {aid}")
        except Exception as e:
            print(f"  获取aid失败: {e}")
            continue
        
        # 删除
        try:
            result = await delete_video(bvid, aid, cred)
            if result.get('code') == 0:
                print(f"  ✅ 删除成功")
            else:
                print(f"  ❌ 删除失败")
        except Exception as e:
            print(f"  ❌ 异常: {e}")
        
        await asyncio.sleep(3)

asyncio.run(main())
