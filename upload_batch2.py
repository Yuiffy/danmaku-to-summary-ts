#!/usr/bin/env python
"""批量投稿脚本 - 第二批 11-18"""
import subprocess
import sys
import os
import time
import re

WORK_DIR = r"D:\workspace\myrepo\danmaku-to-summary-ts"
TAGS = "岁己SUI,虚拟主播,直播切片,岁己"
SOURCE_DESC = "岁己SUI 直播 2026-06-07 悠哉悠哉夜晚！"
TID = "21"
CLIP_DIR = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_07\own_stream_fun_clips"

videos = [
    (11, f"{CLIP_DIR}\\录制-25788785-20260607-194144-335-悠哉悠哉夜晚！_fun_11_031049.mp4", "【岁己】黑绫波丽一出，全场破防", "岁己看到黑绫波丽，反应炸裂。"),
    (12, f"{CLIP_DIR}\\录制-25788785-20260607-194144-335-悠哉悠哉夜晚！_fun_12_031557.mp4", "【岁己】吐槽绫波丽像冷暴力女友", "岁己锐评绫波丽，说她像冷暴力。"),
    (13, f"{CLIP_DIR}\\录制-25788785-20260607-194144-335-悠哉悠哉夜晚！_fun_13_031929.mp4", "【岁己】钢琴双人戏，弹幕嗑疯了", "岁己和角色弹钢琴双人合奏，弹幕集体嗑CP。"),
    (14, f"{CLIP_DIR}\\录制-25788785-20260607-194144-335-悠哉悠哉夜晚！_fun_14_034655.mp4", "【岁己】克隆人设定引爆弹幕", "克隆人话题一出，弹幕瞬间炸了。"),
    (15, f"{CLIP_DIR}\\录制-25788785-20260607-194144-335-悠哉悠哉夜晚！_fun_15_034848.mp4", "【岁己】没电了还在认真讲故事", "岁己手机快没电了，但还是坚持认真讲故事。"),
    (16, f"{CLIP_DIR}\\录制-25788785-20260607-194144-335-悠哉悠哉夜晚！_fun_16_035635.mp4", "【岁己】第四次冲击要来了！", "岁己激动宣布第四次冲击要来了。"),
    (17, f"{CLIP_DIR}\\录制-25788785-20260607-194144-335-悠哉悠哉夜晚！_fun_17_040149.mp4", "【岁己】你哭啥，全都怪你", "岁己和角色互动，最后甩锅：你哭啥全都怪你。"),
    (18, f"{CLIP_DIR}\\录制-25788785-20260607-194144-335-悠哉悠哉夜晚！_fun_18_043155.mp4", "【岁己】先一步成为大人了", "岁己感慨成长话题，先一步成为大人了。"),
]

results = []

for i, (idx, filepath, title, desc) in enumerate(videos):
    print(f"\n{'='*60}")
    print(f"[{idx}] {title}")
    print(f"{'='*60}")

    bvid = None
    success = False

    for attempt in range(2):  # max 1 retry
        if attempt > 0:
            print(f"[RETRY] 第 {attempt} 次重试...")
            time.sleep(10)

        cmd = [
            sys.executable, "src\\scripts\\bilibili_upload.py",
            filepath,
            "--title", title,
            "--desc", desc,
            "--tags", TAGS,
            "--tid", TID,
            "--source-desc", SOURCE_DESC,
        ]

        try:
            proc = subprocess.run(
                cmd,
                cwd=WORK_DIR,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=600,
            )
            output = proc.stdout + "\n" + proc.stderr
            print(output)

            # Extract bvid
            m = re.search(r'(BV[A-Za-z0-9]{10})', output)
            if m:
                bvid = m.group(1)
                success = True
                print(f"[OK] bvid={bvid}")
                break
            elif proc.returncode == 0:
                # Success but no bvid found
                success = True
                print("[WARN] exit 0 but no bvid found")
                break
            else:
                print(f"[FAIL] exit={proc.returncode}")

        except Exception as e:
            print(f"[ERROR] {e}")

    results.append((idx, title, bvid, success))

    # Wait 30s between uploads
    if i < len(videos) - 1:
        print("\n[WAIT] 30 seconds...")
        time.sleep(30)

# Summary table
print("\n\n" + "=" * 60)
print("投稿汇总")
print("=" * 60)
print(f"{'序号':<6}{'标题':<30}{'BV号':<16}{'链接'}")
print("-" * 80)
for idx, title, bvid, success in results:
    status = "OK" if success else "FAIL"
    bv = bvid if bvid else "失败"
    link = f"https://www.bilibili.com/video/{bvid}" if bvid else "-"
    print(f"{idx:<6}{title:<30}{bv:<16}{link}")
print("=" * 60)
