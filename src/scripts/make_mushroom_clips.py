#!/usr/bin/env python
"""切第二组新片段：下劈跳蘑菇+打怪"""
import subprocess
import os
import sys
import re

project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(project_root, 'src', 'scripts'))

CLIPS_DIR = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_14\own_stream_fun_clips"
SOURCE_FLV = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_14\录制-25788785-20260614-195127-019-悠哉悠哉夜晚_merged.flv"
SOURCE_SRT = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_14\录制-25788785-20260614-195127-019-悠哉悠哉夜晚_merged.srt"

CLIPS = [
    ("mushroom_pogo_1", "03:35:30", "03:38:45",
     "弹幕说能爬墙为什么不打怪，小岁：我打不过他抱歉让你失望了"),
    ("mushroom_pogo_2", "03:41:15", "03:44:45",
     "下劈跳蘑菇疯狂朝反方向冲，小岁嗷嗷叫直呼不行了，弹幕急到教用摇杆"),
]

def time_to_seconds(t):
    h, m, s = t.split(':')
    return int(h) * 3600 + int(m) * 60 + float(s)

def trim_srt(start_sec, end_sec, output_path):
    with open(SOURCE_SRT, 'r', encoding='utf-8-sig') as f:
        content = f.read()
    blocks = content.strip().split('\n\n')
    output = []
    idx = 1
    for b in blocks:
        lines = b.strip().split('\n')
        if len(lines) < 3:
            continue
        time_line = lines[1]
        m = re.match(r'(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})', time_line)
        if not m:
            continue
        start = int(m[1])*3600 + int(m[2])*60 + int(m[3]) + int(m[4])/1000.0
        end_t = int(m[5])*3600 + int(m[6])*60 + int(m[7]) + int(m[8])/1000.0
        if start < start_sec or start >= end_sec:
            continue
        new_start = start - start_sec
        new_end = end_t - start_sec
        def fmt(sec):
            h = int(sec // 3600); m_ = int((sec % 3600) // 60); s = int(sec % 60); ms = int((sec % 1) * 1000)
            return f"{h:02d}:{m_:02d}:{s:02d},{ms:03d}"
        new_time = f"{fmt(new_start)} --> {fmt(new_end)}"
        output.append(f"{idx}\n{new_time}\n" + '\n'.join(lines[2:]))
        idx += 1
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n\n'.join(output) + '\n')
    print(f"  SRT: {len(output)} entries -> {output_path}")
    return output_path

def make_clip(name, start, end, title):
    print(f"\n{'='*60}")
    print(f"[CLIP] {name}: {title}")
    print(f"  Time: {start} ~ {end}")
    start_sec = time_to_seconds(start)
    end_sec = time_to_seconds(end)
    srt_path = os.path.join(CLIPS_DIR, f"clip_{name}.srt")
    trim_srt(start_sec, end_sec, srt_path)
    output_mp4 = os.path.join(CLIPS_DIR, f"录制-25788785-20260614-195127-019-悠哉悠哉夜晚_merged_fun_{name}.mp4")
    srt_path_ff = srt_path.replace('\\', '/').replace(':', '\\:')
    subtitle_filter = f"subtitles='{srt_path_ff}':force_style='FontSize=28,FontName=Microsoft YaHei,Bold=1,Outline=2'"
    cmd = [
        'ffmpeg', '-ss', start, '-to', end, '-i', SOURCE_FLV,
        '-vf', subtitle_filter,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-avoid_negative_ts', 'make_zero',
        '-y', '-loglevel', 'error', output_mp4
    ]
    print(f"  Encoding...")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        print(f"  ❌ ffmpeg失败: {result.stderr[:500]}")
        return None
    size = os.path.getsize(output_mp4) / (1024*1024)
    print(f"  ✅ {os.path.basename(output_mp4)} ({size:.1f}MB)")
    try: os.remove(srt_path)
    except: pass
    return output_mp4

for name, start, end, title in CLIPS:
    make_clip(name, start, end, title)
print("\n✅ 切片完成！")
