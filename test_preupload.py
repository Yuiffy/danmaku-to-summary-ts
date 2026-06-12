import asyncio
import json
import sys
import os

sys.path.insert(0, 'src/scripts')
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src', 'scripts'))

from bilibili_api import Credential, get_client
from config_loader import find_secrets_path


async def test():
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
        dedeuserid=cookies.get('DedeUserID', '412141275'),
        ac_time_value=cookies.get('ac_time_value', ''),
    )

    session = get_client()
    resp = await session.request(
        method="GET",
        url="https://member.bilibili.com/preupload",
        params={
            "profile": "ugcfx/bup",
            "name": "test.mp4",
            "size": 12500000,
            "r": "os",
            "ssl": "0",
            "version": "2.14.0",
            "build": "2100400",
            "upcdn": "bda2",
            "probe_version": "20221109",
        },
        cookies=await cred.get_buvid_cookies(),
        headers={
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://www.bilibili.com",
        },
    )
    print("Status:", resp.code)
    print("Headers:", dict(resp.headers))
    raw = resp.raw_text if hasattr(resp, "raw_text") else str(resp)
    print("Body:", raw[:1000])


asyncio.run(test())
