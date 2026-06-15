#!/usr/bin/env python
"""
切片制作工具 - 从录制文件中切出指定片段，烧录字幕，生成封面
"""
import subprocess
import os
import sys
import re

# Add scripts path for cover_generator
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(project_root, 'src', 'scripts'))

CLIPS_DIR = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_14\own_stream_fun_clips"
SOURCE_FLV = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_14\录制-25788785-20260614-195127-019-悠哉悠哉夜晚_merged.flv"
SOURCE_SRT = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_14\录制-25788785-20260614-195127-019-悠哉悠哉夜晚_merged.srt"

# 切片定义: (name, start, end, title)
CLIPS = [
    # 砸地没能量片段
    ("smash_energy", "03:25:00", "03:29:00", 
     "往下砸发现没能量了，小岁急得满地找怪吸魂"),
    # 斗兽场下劈打怪跳跳乐
    ("colosseum_pogo", "04:09:30", "04:13:30",
     "斗兽场强行下劈打怪，小岁嗷嗷叫就是不承认自己不会"),
    # 斗兽场空战+爬墙下劈
    ("colosseum_air", "04:17:00", "04:23:00",
     "斗兽场纯空战没有地板，小岁爬墙加下劈给弹幕看傻了"),
]

def time_to_seconds(t):
    h, m, s = t.split(':')
    return int(h) * 3600 + int(m) * 60 + float(s)

def trim_srt(start_sec, end_sec, output_path):
    """裁剪SRT字幕，重置时间轴"""
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
        
        # 只保留在范围内的
        if start < start_sec or start >= end_sec:
            continue
        
        # 重置时间轴
        new_start = start - start_sec
        new_end = end_t - start_sec
        
        def fmt(sec):
            h = int(sec // 3600)
            m_ = int((sec % 3600) // 60)
            s = int(sec % 60)
            ms = int((sec % 1) * 1000)
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
    
    # 1. 裁剪SRT
    start_sec = time_to_seconds(start)
    end_sec = time_to_seconds(end)
    srt_path = os.path.join(CLIPS_DIR, f"clip_{name}.srt")
    trim_srt(start_sec, end_sec, srt_path)
    
    # 2. ffmpeg切片 + 烧录字幕
    output_mp4 = os.path.join(CLIPS_DIR, f"录制-25788785-20260614-195127-019-悠哉悠哉夜晚_merged_fun_{name}.mp4")
    
    # 字幕滤镜样式（跟 topic_clipper.js 一致）
    subtitle_filter = f"subtitles='{srt_path.replace(chr(92), '/')}'.replace(',', '\\,'):force_style='FontSize=28,FontName=Microsoft YaHei,Bold=1,Outline=2'"
    # 在Windows路径中处理反斜杠
    srt_path_ff = srt_path.replace('\\', '/').replace(':', '\\:')
    subtitle_filter = f"subtitles='{srt_path_ff}':force_style='FontSize=28,FontName=Microsoft YaHei,Bold=1,Outline=2'"
    
    cmd = [
        'ffmpeg',
        '-ss', start,
        '-to', end,
        '-i', SOURCE_FLV,
        '-vf', subtitle_filter,
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-avoid_negative_ts', 'make_zero',
        '-y', '-loglevel', 'error',
        output_mp4
    ]
    
    print(f"  Encoding...")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        print(f"  ❌ ffmpeg失败: {result.stderr[:500]}")
        return None
    else:
        size = os.path.getsize(output_mp4) / (1024*1024)
        print(f"  ✅ {os.path.basename(output_mp4)} ({size:.1f}MB)")
    
    # 3. 清理临时SRT
    try:
        os.remove(srt_path)
    except:
        pass
    
    return output_mp4

# 处理所有切片
for name, start, end, title in CLIPS:
    make_clip(name, start, end, title)

print("\n✅ 所有切片完成！")
