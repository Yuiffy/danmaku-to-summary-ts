#!/usr/bin/env python
"""上传跳蘑菇切片"""
import sys, os, json, asyncio, subprocess

project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(project_root, 'src', 'scripts'))

from config_loader import find_secrets_path
from bilibili_api import Credential, video_uploader, Picture
from cover_generator import CoverGenerator

DEFAULT_TID = 21
ACCOUNT_MID = 412141275
CLIPS_DIR = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_14\own_stream_fun_clips"
TAGS = ["小岁", "虚拟主播", "直播切片", "岁AI切片", "空洞骑士"]
SOURCE_DESC = "岁己SUI 直播《悠哉悠哉夜晚》2026-06-14"
UPLOAD_INTERVAL = 60

CLIPS = [
    {
        "file": "录制-25788785-20260614-195127-019-悠哉悠哉夜晚_merged_fun_mushroom_pogo_1.mp4",
        "title": "弹幕说能爬墙为什么不打怪，小岁理直气壮：我打不过他抱歉让你失望了",
    },
    {
        "file": "录制-25788785-20260614-195127-019-悠哉悠哉夜晚_merged_fun_mushroom_pogo_2.mp4",
        "title": "下劈跳蘑菇疯狂朝反方向冲，小岁嗷嗷叫直呼不行了，弹幕急到教用摇杆",
    },
]

def fix_title(t):
    t = t.replace("岁己", "小岁")
    if not t.startswith("【小岁】"): t = f"【小岁】{t}"
    return t

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
        sessdata=cookies.get('SESSDATA', ''), bili_jct=cookies.get('bili_jct', ''),
        buvid3=cookies.get('buvid3', ''),
        dedeuserid=cookies.get('DedeUserID', str(ACCOUNT_MID)),
        ac_time_value=cookies.get('ac_time_value', ''),
    )

async def upload_one(video_path, title, desc, cover_path, credential):
    file_size = os.path.getsize(video_path) / (1024 * 1024)
    print(f"\n{'='*60}")
    print(f"[UPLOAD] {title}")
    print(f"[FILE] {os.path.basename(video_path)} ({file_size:.1f}MB)")
    page = video_uploader.VideoUploaderPage(path=video_path, title=title, description=desc)
    cover = Picture.from_file(cover_path)
    meta = video_uploader.VideoMeta(tid=DEFAULT_TID, title=title, desc=desc, cover=cover,
        tags=TAGS, original=False, source="直播切片")
    uploader = video_uploader.VideoUploader(pages=[page], meta=meta, credential=credential)
    try:
        result = await uploader.start()
        if result:
            bvid = result.get('bvid', 'N/A') if isinstance(result, dict) else 'N/A'
            print(f"  ✅ 成功! bvid: {bvid}")
            return {"success": True, "title": title, "bvid": bvid}
        else:
            print(f"  ❌ 失败")
            return {"success": False, "title": title, "error": "falsy"}
    except Exception as e:
        print(f"  ❌ 异常: {e}")
        return {"success": False, "title": title, "error": str(e)}

async def main():
    credential = build_credential()
    print("[INFO] 凭证已创建")
    gen = CoverGenerator()
    results = []
    for i, clip in enumerate(CLIPS, 1):
        video_path = os.path.join(CLIPS_DIR, clip["file"])
        title = fix_title(clip["title"])
        if not os.path.exists(video_path):
            print(f"[WARN] 文件不存在: {video_path}")
            continue
        print(f"\n[{i}/{len(CLIPS)}] 生成封面...")
        cover_path = os.path.join(CLIPS_DIR, f'_cover_{clip["file"]}.jpg')
        try:
            gen.generate_cover(video_path=video_path, title=title, output_path=cover_path, use_key_frame=True)
        except Exception as e:
            print(f"  封面失败: {e}，用第一帧")
            subprocess.run(['ffmpeg', '-i', video_path, '-vframes', '1', '-q:v', '2', cover_path, '-y', '-loglevel', 'error'], check=True, timeout=30)
        desc = f"直播切片\n\n来源：{SOURCE_DESC}"
        result = await upload_one(video_path, title, desc, cover_path, credential)
        results.append(result)
        if os.path.exists(cover_path):
            try: os.remove(cover_path)
            except: pass
        if i < len(CLIPS):
            print(f"[WAIT] {UPLOAD_INTERVAL}秒...")
            for r in range(UPLOAD_INTERVAL, 0, -10):
                print(f"  {r}s...", end='\r', flush=True)
                await asyncio.sleep(10)
            print(" " * 20, end='\r', flush=True)
    ok = sum(1 for r in results if r["success"])
    print(f"\n[完成] 成功 {ok}, 失败 {len(results)-ok}")
    for r in results:
        status = "✅" if r["success"] else "❌"
        print(f"  {status} {r['title']} - {r.get('bvid', r.get('error', 'N/A'))}")

if __name__ == "__main__":
    asyncio.run(main())
