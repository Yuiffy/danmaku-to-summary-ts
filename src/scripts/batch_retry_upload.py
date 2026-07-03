#!/usr/bin/env python
"""Batch retry upload for failed clips with 406 error."""
import asyncio
import os
import sys
import time

# Add project path
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(project_root, 'src', 'scripts'))

from bilibili_upload import build_credential, upload_video

CLIPS_DIR = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_07_02\own_stream_fun_clips"
BASE_NAME = "录制-25788785-20260702-201648-560-陪陪你这个猪_merged"

CLIPS = [
    {
        "num": "06",
        "suffix": "014026",
        "title": "【小岁】刚吹完牛要深度解析，下一秒直接看懵：老子没看懂这演的啥",
    },
    {
        "num": "13",
        "suffix": "031542",
        "title": "【小岁】只要逆转时间，吃得越多瘦得越快？鬼才减肥逻辑给弹幕干烧了",
    },
    {
        "num": "14",
        "suffix": "032106",
        "title": "【小岁】看到两个金毛当场宕机：他把自己杀了？弹幕：你脑子要长出来了",
    },
    {
        "num": "15",
        "suffix": "033330",
        "title": "【小岁】越描越黑的解说，弹幕：不要试图理解，请用心去感受",
    },
    {
        "num": "16",
        "suffix": "034033",
        "title": "【小岁】硬核分析钳形攻势：红队蓝队谁是反的？弹幕：你是蓝队的吧",
    },
    {
        "num": "17",
        "suffix": "034456",
        "title": "【小岁】这么多人冲锋也叫精英部队？锐评大场面打仗像干拉",
    },
    {
        "num": "18",
        "suffix": "043718",
        "title": "【小岁】逻辑鬼才！因为五点钟尿过，所以逆行回去尿尿？",
    },
]

TAGS = ["小岁", "虚拟主播", "直播切片", "岁AI切片"]
DESC = "切片来自 2026-07-02 直播「陪陪你这个猪」"

async def upload_one(clip, credential):
    video_path = os.path.join(CLIPS_DIR, f"{BASE_NAME}_fun_{clip['num']}_{clip['suffix']}.mp4")
    cover_path = os.path.join(CLIPS_DIR, f"{BASE_NAME}_fun_{clip['num']}_{clip['suffix']}_cover.jpg")
    
    print(f"\n{'='*60}")
    print(f"[UPLOAD] Clip {clip['num']}: {clip['title']}")
    print(f"{'='*60}")
    
    try:
        result = await upload_video(
            video_path=video_path,
            title=clip['title'],
            desc=DESC,
            tags=TAGS,
            tid=21,
            cover_path=cover_path,
            credential=credential,
        )
        if result and isinstance(result, dict) and result.get('bvid'):
            print(f"[OK] Clip {clip['num']} => BV: {result['bvid']}")
            return result['bvid']
        else:
            print(f"[WARN] Clip {clip['num']} upload returned: {result}")
            return None
    except Exception as e:
        print(f"[ERROR] Clip {clip['num']} failed: {e}")
        return None

async def main():
    credential = build_credential()
    print("[INFO] Credential built successfully")
    
    results = {}
    
    for i, clip in enumerate(CLIPS):
        # Wait 30s between uploads (skip before first)
        if i > 0:
            print(f"\n[WAIT] Sleeping 30s before next upload...")
            await asyncio.sleep(30)
        
        bvid = await upload_one(clip, credential)
        
        if bvid is None:
            # Retry once after 60s
            print(f"\n[RETRY] Clip {clip['num']} failed, waiting 60s before retry...")
            await asyncio.sleep(60)
            bvid = await upload_one(clip, credential)
        
        results[clip['num']] = bvid
    
    # Summary
    print(f"\n{'='*60}")
    print("[SUMMARY]")
    print(f"{'='*60}")
    success = []
    failed = []
    for num, bvid in results.items():
        if bvid:
            success.append(f"  Clip {num}: {bvid}")
        else:
            failed.append(f"  Clip {num}: FAILED")
    if success:
        print("Success:")
        for s in success:
            print(s)
    if failed:
        print("Failed:")
        for f in failed:
            print(f)

asyncio.run(main())
