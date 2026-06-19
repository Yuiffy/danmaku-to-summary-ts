"""Upload clip 19 - 鸣潮漂泊者剧情"""
import sys, os, json, asyncio
SCRIPTS_DIR = os.path.join('D:', os.sep, 'workspace', 'myrepo', 'danmaku-to-summary-ts', 'src', 'scripts')
sys.path.insert(0, SCRIPTS_DIR)
from config_loader import get_config, find_secrets_path
from bilibili_api import Credential, video_uploader, Picture
import requests

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

def search_existing(cookie_str, keyword):
    headers = {'User-Agent': 'Mozilla/5.0', 'Cookie': cookie_str, 'Referer': 'https://search.bilibili.com'}
    r = requests.get('https://api.bilibili.com/x/web-interface/search/type',
        params={'search_type': 'video', 'keyword': keyword, 'order': 'pubdate', 'page': 1},
        headers=headers, timeout=15)
    data = r.json()
    if data.get('code') != 0:
        return {}
    existing = {}
    import re
    for item in (data.get('data') or {}).get('result') or []:
        if item.get('mid') == ACCOUNT_MID:
            title = re.sub(r'<[^>]+>', '', item.get('title', ''))
            existing[title] = item.get('bvid', '')
    return existing

async def main():
    title = "【小岁】戴夫游戏里冒出漂泊者名师，岁己念着念着开始瞎吹"
    filepath = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_18\own_stream_fun_clips\录制-25788785-20260618-195202-513-悠哉悠哉夜晚_merged_fun_19_050110.mp4"
    tags = ["小岁", "虚拟主播", "直播切片", "岁AI切片"]
    desc = """直播切片
戴夫游戏里冒出漂泊者名师，岁己念着念着开始瞎吹

来源：岁己SUI 直播《悠哉悠哉夜晚》2026-06-18
切片时间：05:01:10 - 05:06:10（直播开始后第301分钟）"""

    # 查重
    secrets_path = find_secrets_path()
    with open(secrets_path, 'r', encoding='utf-8-sig') as f:
        secrets = json.load(f)
    cookie_str = secrets.get('bilibili', {}).get('cookie', '')
    existing = search_existing(cookie_str, "小岁 漂泊者")
    if title in existing:
        print(f"[SKIP] 已存在: {existing[title]}")
        return

    if not os.path.exists(filepath):
        print(f"[ERROR] 文件不存在: {filepath}")
        return

    # 截封面
    cover_tmp = filepath.replace('.mp4', '_cover_tmp.jpg')
    import subprocess
    subprocess.run(['ffmpeg', '-i', filepath, '-vframes', '1', '-q:v', '2', cover_tmp, '-y', '-loglevel', 'error'],
                   check=True, timeout=30)
    cover = Picture.from_file(cover_tmp)

    credential = build_credential()
    page = video_uploader.VideoUploaderPage(path=filepath, title=title, description=desc)
    meta = video_uploader.VideoMeta(
        tid=21, title=title, desc=desc, cover=cover,
        tags=tags, original=False, source="直播切片",
    )
    uploader = video_uploader.VideoUploader(pages=[page], meta=meta, credential=credential)
    print(f"开始上传: {title}")
    print(f"文件: {os.path.basename(filepath)} ({os.path.getsize(filepath)/1024/1024:.1f}MB)")

    result = await uploader.start()
    if result and isinstance(result, dict) and result.get('bvid'):
        print(f"✅ 成功: {result['bvid']}")
    else:
        print(f"❌ 结果: {result}")

    try: os.remove(cover_tmp)
    except: pass

asyncio.run(main())
