"""Test preupload with full headers matching browser."""
import asyncio
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src', 'scripts'))

from bilibili_api import Credential, get_client
from config_loader import find_secrets_path


async def test():
    secrets_path = find_secrets_path()
    with open(secrets_path, 'r', encoding='utf-8-sig') as f:
        secrets = json.load(f)
    cookie_str = secrets.get('bilibili', {}).get('cookie', '')
    cookies_dict = {}
    for item in cookie_str.split(';'):
        item = item.strip()
        if '=' in item:
            k, v = item.split('=', 1)
            cookies_dict[k.strip()] = v.strip()

    cred = Credential(
        sessdata=cookies_dict.get('SESSDATA', ''),
        bili_jct=cookies_dict.get('bili_jct', ''),
        buvid3=cookies_dict.get('buvid3', ''),
        dedeuserid=cookies_dict.get('DedeUserID', '412141275'),
        ac_time_value=cookies_dict.get('ac_time_value', ''),
    )

    buvid_cookies = await cred.get_buvid_cookies()
    print("buvid_cookies:", buvid_cookies)

    session = get_client()

    # Try with profile=ugcfx/bup (what the code actually sends)
    resp = await session.request(
        method="GET",
        url="https://member.bilibili.com/preupload",
        params={
            "profile": "ugcfx/bup",
            "name": "test.mp4",
            "size": 12500000,
            "r": "upos",
            "ssl": "0",
            "version": "2.14.0",
            "build": "2100400",
            "upcdn": "bda2",
            "probe_version": 20221109,
        },
        cookies=buvid_cookies,
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
            "Referer": "https://www.bilibili.com",
        },
    )
    print("Profile ugcfx/bup - Status:", resp.code)
    raw = resp.raw_text if hasattr(resp, "raw_text") else str(resp)
    print("Body:", raw[:500])

    # Also try with profile=ugcfr/pc3 (from API definition)
    resp2 = await session.request(
        method="GET",
        url="https://member.bilibili.com/preupload",
        params={
            "profile": "ugcfr/pc3",
            "name": "test.mp4",
            "size": 12500000,
            "r": "upos",
            "ssl": "0",
            "version": "2.10.4",
            "build": "2100400",
            "upcdn": "bda2",
            "probe_version": 20221109,
        },
        cookies=buvid_cookies,
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
            "Referer": "https://www.bilibili.com",
        },
    )
    print("\nProfile ugcfr/pc3 - Status:", resp2.code)
    raw2 = resp2.raw_text if hasattr(resp2, "raw_text") else str(resp2)
    print("Body:", raw2[:500])


asyncio.run(test())
