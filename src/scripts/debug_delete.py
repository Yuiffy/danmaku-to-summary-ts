#!/usr/bin/env python
"""调试删除接口 - 看实际返回内容"""
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

TARGETS = [
    ("BV1rJJN6YE3U", 116749844354822),
    ("BV16HJN6wEno", 116749827577568),
    ("BV16JJN6YE6T", 116749844355122),
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

async def try_delete(cred: Credential):
    cookies_str = f"SESSDATA={cred.sessdata}; bili_jct={cred.bili_jct}; DedeUserID={cred.dedeuserid}; buvid3={cred.buvid3}"
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://member.bilibili.com/upload-manager/article',
        'Origin': 'https://member.bilibili.com',
        'Cookie': cookies_str,
    }

    async with httpx.AsyncClient(headers=headers, timeout=30) as client:
        for bvid, aid in TARGETS:
            print(f"\n=== {bvid} (aid={aid}) ===")
            
            # 尝试方式1: member.bilibili.com 接口
            url1 = 'https://member.bilibili.com/x/web/archive/dql'
            data1 = {
                'aid': aid,
                'csrf': cred.bili_jct,
            }
            print(f"POST {url1}")
            resp = await client.post(url1, data=data1)
            print(f"  status={resp.status_code}")
            print(f"  content-type={resp.headers.get('content-type', '')}")
            text = resp.text[:500]
            print(f"  body={text}")
            
            await asyncio.sleep(2)
            
            # 尝试方式2: api.bilibili.com 接口
            url2 = 'https://api.bilibili.com/x/web/archive/dql'
            data2 = {
                'aid': aid,
                'csrf': cred.bili_jct,
            }
            print(f"POST {url2}")
            resp2 = await client.post(url2, data=data2)
            print(f"  status={resp2.status_code}")
            text2 = resp2.text[:500]
            print(f"  body={text2}")
            
            await asyncio.sleep(2)

async def main():
    cred = build_credential()
    await try_delete(cred)

asyncio.run(main())
