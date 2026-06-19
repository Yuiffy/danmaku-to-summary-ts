#!/usr/bin/env python
"""
重试上传剩余6个切片（之前全部406失败）
- 栞栞 1个 + 岁己晚间直播 5个(fun_12~16)
- 每个间隔120秒，避免风控
"""
import sys
import os
import json
import asyncio
import subprocess

project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(project_root, 'src', 'scripts'))

from config_loader import find_secrets_path
from bilibili_api import Credential, video_uploader, Picture

DEFAULT_TID = 21
ACCOUNT_MID = 412141275
UPLOAD_INTERVAL = 120  # 2分钟间隔

# 栞栞 clip
SHIORI_DIR = r"D:\files\videos\DDTV录播\26966466_栞栞Shiori\2026_06_17\topic_clips"
SUI_DIR = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_17\own_stream_fun_clips"

CLIPS = [
    {
        "video": os.path.join(SHIORI_DIR, "录制-26966466-20260617-210654-819-小栞来！_merged_topic_1-1_003805.mp4"),
        "cover": os.path.join(SHIORI_DIR, "录制-26966466-20260617-210654-819-小栞来！_merged_topic_1-1_003805_cover.jpg"),
        "title": "【小栞】你每次repo都说我在看岁己？明明别的切片也看了啊！",
        "desc": "直播切片\n\n来源：栞栞Shiori 直播《小栞来！》2026-06-17",
        "tags": ["小栞", "岁己", "小岁", "虚拟主播", "直播切片", "栞栞", "栞栞Shiori"],
    },
    {
        "video": os.path.join(SUI_DIR, "录制-25788785-20260617-223556-486-温柔煮死你_fun_12_015346.mp4"),
        "cover": os.path.join(SUI_DIR, "cover_12.jpg"),
        "title": "【小岁】手抓饼全家福也是减肥餐？只吃三分之二就不算过分是吧",
        "desc": "直播切片\n\n来源：岁己SUI 直播《温柔煮死你》2026-06-17",
        "tags": ["小岁", "虚拟主播", "直播切片", "岁AI切片"],
    },
    {
        "video": os.path.join(SUI_DIR, "录制-25788785-20260617-223556-486-温柔煮死你_fun_13_015733.mp4"),
        "cover": os.path.join(SUI_DIR, "cover_13.jpg"),
        "title": "【小岁】顶级富婆发言：高中最阔绰的时候是早上敢坐下来吃一碗粉",
        "desc": "直播切片\n\n来源：岁己SUI 直播《温柔煮死你》2026-06-17",
        "tags": ["小岁", "虚拟主播", "直播切片", "岁AI切片"],
    },
    {
        "video": os.path.join(SUI_DIR, "录制-25788785-20260617-223556-486-温柔煮死你_fun_14_020123.mp4"),
        "cover": os.path.join(SUI_DIR, "cover_14.jpg"),
        "title": "【小岁】吃鹅肉会变聪明因为鹅有智力？为了证明没吃错鸭子开始疯狂自证",
        "desc": "直播切片\n\n来源：岁己SUI 直播《温柔煮死你》2026-06-17",
        "tags": ["小岁", "虚拟主播", "直播切片", "岁AI切片"],
    },
    {
        "video": os.path.join(SUI_DIR, "录制-25788785-20260617-223556-486-温柔煮死你_fun_15_020658.mp4"),
        "cover": os.path.join(SUI_DIR, "cover_15.jpg"),
        "title": "【小岁】生场病连吃辣能力都被重塑了？挑战地狱辣薯片直接辣到眼冒金星",
        "desc": "直播切片\n\n来源：岁己SUI 直播《温柔煮死你》2026-06-17",
        "tags": ["小岁", "虚拟主播", "直播切片", "岁AI切片"],
    },
    {
        "video": os.path.join(SUI_DIR, "录制-25788785-20260617-223556-486-温柔煮死你_fun_16_021451.mp4"),
        "cover": os.path.join(SUI_DIR, "cover_16.jpg"),
        "title": "【小岁】还说自己是小孩子不能考虑？弹幕直接刷到500岁再说",
        "desc": "直播切片\n\n来源：岁己SUI 直播《温柔煮死你》2026-06-17",
        "tags": ["小岁", "虚拟主播", "直播切片", "岁AI切片"],
    },
]


def build_credential() -> Credential:
    secrets_path = find_secrets_path()
    with open(secrets_path, 'r', encoding='utf-8-sig') as f:
        secrets = json.load(f)
    cookie_str = secrets.get('bilibili', {}).get('cookie', '')
    if not cookie_str:
        print("[ERROR] 未找到B站Cookie")
        sys.exit(1)
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


async def upload_one(clip: dict, credential: Credential) -> dict:
    video_path = clip["video"]
    title = clip["title"]
    desc = clip["desc"]
    tags = clip["tags"]
    cover_path = clip["cover"]

    # Check file exists
    if not os.path.exists(video_path):
        print(f"  ❌ 视频文件不存在: {video_path}")
        return {"success": False, "title": title, "error": "video not found"}

    file_size = os.path.getsize(video_path) / (1024 * 1024)
    print(f"\n{'='*60}")
    print(f"[UPLOAD] {title}")
    print(f"[FILE] {os.path.basename(video_path)} ({file_size:.1f}MB)")

    # Prepare cover
    cover = None
    if cover_path and os.path.exists(cover_path):
        cover = Picture.from_file(cover_path)
        print(f"[COVER] {os.path.basename(cover_path)}")
    else:
        # Fallback: extract first frame
        cover_tmp = os.path.join(os.path.dirname(video_path), '_tmp_retry_cover.jpg')
        subprocess.run([
            'ffmpeg', '-i', video_path, '-vframes', '1',
            '-q:v', '2', cover_tmp, '-y', '-loglevel', 'error'
        ], check=True, timeout=30)
        cover = Picture.from_file(cover_tmp)
        print(f"[COVER] 从视频截取第一帧")

    page = video_uploader.VideoUploaderPage(
        path=video_path,
        title=title,
        description=desc,
    )

    meta = video_uploader.VideoMeta(
        tid=DEFAULT_TID,
        title=title,
        desc=desc,
        cover=cover,
        tags=tags,
        original=False,
        source="直播切片",
    )

    uploader = video_uploader.VideoUploader(
        pages=[page],
        meta=meta,
        credential=credential,
    )

    try:
        result = await uploader.start()
        if result:
            bvid = result.get('bvid', 'N/A') if isinstance(result, dict) else 'N/A'
            print(f"  ✅ 成功! bvid: {bvid}")
            return {"success": True, "title": title, "bvid": bvid, "result": result}
        else:
            print(f"  ❌ 失败")
            return {"success": False, "title": title, "error": "upload returned falsy"}
    except Exception as e:
        print(f"  ❌ 异常: {e}")
        return {"success": False, "title": title, "error": str(e)}


async def main():
    credential = build_credential()
    print("[INFO] 凭证已创建")
    print(f"[INFO] 共 {len(CLIPS)} 个视频待上传")
    print(f"[INFO] 每个间隔 {UPLOAD_INTERVAL} 秒")

    # Verify all files exist first
    print("\n[CHECK] 验证文件...")
    all_ok = True
    for clip in CLIPS:
        v_exists = os.path.exists(clip["video"])
        c_exists = os.path.exists(clip["cover"]) if clip["cover"] else False
        status = "✅" if v_exists else "❌"
        c_status = "✅" if c_exists else "⚠️"
        print(f"  {status} 视频: {os.path.basename(clip['video'])}")
        print(f"  {c_status} 封面: {os.path.basename(clip['cover'])}" if clip['cover'] else "  ⚠️ 无封面")
        if not v_exists:
            all_ok = False
    if not all_ok:
        print("[ERROR] 有视频文件缺失，退出")
        sys.exit(1)
    print("[CHECK] 全部文件就绪 ✅")

    results = []
    for i, clip in enumerate(CLIPS, 1):
        print(f"\n[{'='*20}] {i}/{len(CLIPS)} {'='*20}")
        result = await upload_one(clip, credential)
        results.append(result)

        # Wait between uploads
        if i < len(CLIPS):
            print(f"[WAIT] 等待 {UPLOAD_INTERVAL} 秒...")
            for remaining in range(UPLOAD_INTERVAL, 0, -10):
                print(f"  {remaining}s...", end='\r', flush=True)
                await asyncio.sleep(10)
            print(" " * 20, end='\r', flush=True)

    # Summary
    total_success = sum(1 for r in results if r["success"])
    total_fail = len(results) - total_success
    print(f"\n{'='*60}")
    print(f"[完成] 共 {len(results)} 个, 成功 {total_success}, 失败 {total_fail}")
    print(f"{'='*60}")

    succeeded = [r for r in results if r["success"]]
    if succeeded:
        print("\n成功列表:")
        for r in succeeded:
            print(f"  ✅ {r['title']} - {r.get('bvid', 'N/A')}")

    failed = [r for r in results if not r["success"]]
    if failed:
        print("\n失败列表:")
        for r in failed:
            print(f"  ❌ {r['title']} - {r.get('error', 'unknown')}")

    # Save results
    result_path = os.path.join(SUI_DIR, "upload_results_retry6.json")
    with open(result_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\n[INFO] 结果已保存到 {result_path}")


if __name__ == "__main__":
    asyncio.run(main())
