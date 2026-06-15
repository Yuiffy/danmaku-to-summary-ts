#!/usr/bin/env python
"""
尝试通过B站创作中心的内部API删除/转私密稿件
思路：模拟创作中心网页的XHR请求
"""
import sys
import os
import json
import asyncio
import re

project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(project_root, 'src', 'scripts'))

from config_loader import find_secrets_path
from bilibili_api import Credential
import httpx

ACCOUNT_MID = 412141275

TARGETS = [
    {"bvid": "BV1rJJN6YE3U", "aid": 116749844354822, "title": "一块钱两根雪糕"},
    {"bvid": "BV16HJN6wEno", "aid": 116749827577568, "title": "开播迟到搬水桶"},
    {"bvid": "BV16JJN6YE6T", "aid": 116749844355122, "title": "游泳教练朋友圈"},
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

def get_cookie_str(cred: Credential) -> str:
    return f"SESSDATA={cred.sessdata}; bili_jct={cred.bili_jct}; DedeUserID={cred.dedeuserid}; buvid3={cred.buvid3}"

async def try_approaches(cred: Credential):
    cookie_str = get_cookie_str(cred)
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://member.bilibili.com/upload-manager/article',
        'Origin': 'https://member.bilibili.com',
        'Cookie': cookie_str,
        'Accept': 'application/json, text/plain, */*',
    }

    async with httpx.AsyncClient(headers=headers, timeout=30) as client:
        # 先尝试获取稿件列表，看看创作中心用的是什么接口
        print("=== 尝试获取稿件管理列表 ===")
        
        # 方式1: member.bilibili.com/x/web/Archive/list
        urls_to_try = [
            ("GET", "https://member.bilibili.com/x/web/Archive/list", {"pn": 1, "ps": 5, "tid": 0}),
            ("GET", "https://api.bilibili.com/x/web/Archive/list", {"pn": 1, "ps": 5, "tid": 0}),
        ]
        
        for method, url, params in urls_to_try:
            print(f"\n{method} {url}")
            try:
                if method == "GET":
                    resp = await client.get(url, params=params)
                else:
                    resp = await client.post(url, data=params)
                print(f"  status={resp.status_code}, ct={resp.headers.get('content-type','')[:50]}")
                text = resp.text[:300]
                print(f"  body={text}")
            except Exception as e:
                print(f"  error: {e}")

        # 尝试B站内部的删除接口 - 多种可能
        aid = TARGETS[0]['aid']
        bvid = TARGETS[0]['bvid']
        
        print(f"\n=== 尝试删除 {bvid} (aid={aid}) ===")
        
        delete_urls = [
            ("POST", "https://member.bilibili.com/x/web/archive/del", {"aid": aid, "csrf": cred.bili_jct}),
            ("POST", "https://api.bilibili.com/x/web/archive/del", {"aid": aid, "csrf": cred.bili_jct}),
            ("POST", "https://member.bilibili.com/x/vu/web/archive/del", {"aid": aid, "csrf": cred.bili_jct}),
            ("POST", "https://api.bilibili.com/x/vu/web/archive/del", {"aid": aid, "csrf": cred.bili_jct}),
            ("POST", "https://member.bilibili.com/x/web/archive/manage/del", {"aid": aid, "csrf": cred.bili_jct}),
        ]
        
        for method, url, data in delete_urls:
            print(f"\n{method} {url}")
            try:
                resp = await client.post(url, data=data)
                print(f"  status={resp.status_code}, ct={resp.headers.get('content-type','')[:50]}")
                text = resp.text[:300]
                print(f"  body={text}")
                # 如果返回JSON且code!=404/-404，可能是有效接口
                try:
                    j = json.loads(text)
                    if j.get('code') not in [-404, 404, -403]:
                        print(f"  🎯 可能是有效接口! code={j.get('code')}")
                except:
                    pass
            except Exception as e:
                print(f"  error: {e}")
            await asyncio.sleep(1)

async def main():
    cred = build_credential()
    print("[INFO] 凭证已创建")
    await try_approaches(cred)

asyncio.run(main())
