#!/usr/bin/env python
"""
重新压制 6 个切片的双色字幕
使用相对路径绕过 ffmpeg ass 滤镜的 Windows 路径问题
"""
import os
import sys
import json
import subprocess

CLIPS_DIR = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_04\clips_0607"
ASR_JSON = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_04\rerun_asr_output.json"
VIDEO_SRC_REL = r"..\录制-25788785-20260604-201111-833-高手小岁和臭栞栞玩五子棋_merged.flv"

# Fill: all white for readability
# Outline: colored per speaker
FILL_COLOR = "&H00FFFFFF"     # 文字填充：白色
OUTLINE_SUI = "&H0000008B"    # 岁己 边框：暗红 #8B0000
OUTLINE_SHIORI = "&H00374E6F" # 栞栞 边框：咖啡 #6F4E37
OUTLINE_DEFAULT = "&H00000000" # 默认 边框：黑色
OUTLINE_WIDTH = 4  # BackColour=0, Shadow=0, pure outline only              # 边框宽度（越大越粗）

FONT_SIZE = 100
FONT_NAME = "Microsoft YaHei"

def load_segments():
    with open(ASR_JSON, 'r', encoding='utf-8') as f:
        data = json.load(f)
    return data['segments']

def speaker_style(speaker):
    s = speaker or ''
    if '岁己' in s or 'SUI' in s or 'sui' in s:
        return '岁己SUI'
    if '栞' in s or 'Shiori' in s or 'shiori' in s:
        return '栞栞'
    return 'Default'

def sec_to_ass_time(sec):
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    cs = int(round((sec % 1) * 100))
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"

def generate_ass(segments, clip_start, clip_end, ass_path):
    clip_segs = [s for s in segments if s['start'] >= clip_start and s['end'] <= clip_end]
    
    header = f"""[Script Info]
Title: 岁己×栞栞 切片字幕
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1920
PlayResY: 1080
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: 岁己SUI,{FONT_NAME},{FONT_SIZE},{FILL_COLOR},&H00FFFFFF,{OUTLINE_SUI},&H00000000,-1,0,0,0,100,100,0,0,3,{OUTLINE_WIDTH},1,2,60,60,80,1
Style: 栞栞,{FONT_NAME},{FONT_SIZE},{FILL_COLOR},&H00FFFFFF,{OUTLINE_SHIORI},&H00000000,-1,0,0,0,100,100,0,0,3,{OUTLINE_WIDTH},1,2,60,60,80,1
Style: Default,{FONT_NAME},{FONT_SIZE},{FILL_COLOR},&H00FFFFFF,{OUTLINE_DEFAULT},&H00000000,-1,0,0,0,100,100,0,0,3,{OUTLINE_WIDTH},1,2,60,60,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"""
    
    events = []
    for seg in clip_segs:
        style_name = speaker_style(seg.get('speaker', ''))
        start_ass = sec_to_ass_time(seg['start'] - clip_start)
        end_ass = sec_to_ass_time(seg['end'] - clip_start)
        text = seg['text'].replace('\n', '\\N')
        spk = seg.get('speaker', '未知')
        events.append(f"Dialogue: 0,{start_ass},{end_ass},{style_name},{spk},0,0,0,,{text}")
    
    ass_content = header + '\n' + '\n'.join(events) + '\n'
    
    with open(ass_path, 'w', encoding='utf-8-sig') as f:
        f.write(ass_content)
    
    return len(events)

# Clip definitions: (name, [(start_sec, end_sec), ...])
CLIPS = [
    ("岁己栞栞_扫雷_猪一样的开局", [(4460, 4665)]),
    ("岁己栞栞_扫雷_栞栞教学崩溃", [(4690, 4930)]),
    ("岁己栞栞_扫雷_推算踩雷还自夸", [(4960, 5195)]),
    ("岁己栞栞_飞行棋_飞机被吃好过分", [(5680, 5950)]),
    ("岁己栞栞_飞行棋_托管崩溃无理取闹", [(6020, 6290)]),
    ("岁己栞栞_飞行棋_真的是非常nice", [(6320, 6620)]),
]

def main():
    os.chdir(CLIPS_DIR)
    segments = load_segments()
    print(f"Loaded {len(segments)} ASR segments")
    print(f"Working dir: {os.getcwd()}")
    print(f"Font: {FONT_NAME} {FONT_SIZE}px on 1920x1080")
    
    # Clean old test files
    for f in os.listdir('.'):
        if f.startswith('test_') or f.startswith('_temp'):
            os.remove(f) if os.path.isfile(f) else None
    
    for clip_name, cuts in CLIPS:
        print(f"\n=== {clip_name} ===")
        
        if len(cuts) == 1:
            clip_start, clip_end = cuts[0]
            duration = clip_end - clip_start
            mp4_name = f"{clip_name}.mp4"
            ass_name = f"{clip_name}.ass"
            
            n = generate_ass(segments, clip_start, clip_end, ass_name)
            print(f"  ASS: {n} subtitles")
            
            # Use subtitles filter (handles both srt and ass) with relative path
            vf = f"subtitles='{ass_name}'"
            cmd = [
                'ffmpeg', '-y',
                '-ss', str(clip_start),
                '-i', VIDEO_SRC_REL,
                '-t', str(duration),
                '-vf', vf,
                '-c:v', 'h264_nvenc', '-preset', 'p6', '-cq', '20',
                '-c:a', 'aac', '-b:a', '128k',
                mp4_name
            ]
            print(f"  Burning subtitles ({duration:.0f}s)...")
            result = subprocess.run(cmd, capture_output=True, timeout=600)
            if result.returncode != 0:
                err = result.stderr.decode('utf-8', errors='replace')[-500:] if result.stderr else 'no stderr'
                print(f"  NVENC failed, trying libx264...")
                cmd[cmd.index('h264_nvenc')] = 'libx264'
                cmd[cmd.index('p6')] = 'medium'
                cmd[cmd.index('-cq')] = '-crf'
                cmd[cmd.index('20')] = '20'
                cmd.pop(cmd.index('-preset'))
                result = subprocess.run(cmd, capture_output=True, timeout=600)
            
            if os.path.exists(mp4_name):
                size_mb = os.path.getsize(mp4_name) / (1024*1024)
                print(f"  ✅ {mp4_name} ({size_mb:.1f}MB)")
            else:
                print(f"  ❌ FAILED")
        else:
            # Multi-cut
            temp_dir = '_temp'
            os.makedirs(temp_dir, exist_ok=True)
            part_files = []
            
            for i, (cs, ce) in enumerate(cuts):
                duration = ce - cs
                ass_name = os.path.join(temp_dir, f"part{i}.ass")
                n = generate_ass(segments, cs, ce, ass_name)
                
                part_name = os.path.join(temp_dir, f"part{i}.mp4")
                vf = f"subtitles='{ass_name}'"
                cmd = [
                    'ffmpeg', '-y',
                    '-ss', str(cs),
                    '-i', VIDEO_SRC_REL,
                    '-t', str(duration),
                    '-vf', vf,
                    '-c:v', 'h264_nvenc', '-preset', 'p6', '-cq', '20',
                    '-c:a', 'aac', '-b:a', '128k',
                    part_name
                ]
                print(f"  Part {i+1}/{len(cuts)}: {duration:.0f}s, {n} subs")
                result = subprocess.run(cmd, capture_output=True, timeout=600)
                if result.returncode == 0:
                    part_files.append(part_name)
                else:
                    err = result.stderr.decode('utf-8', errors='replace')[-300:] if result.stderr else ''
                    print(f"  ERROR: {err}")
            
            mp4_name = f"{clip_name}.mp4"
            if len(part_files) == 1:
                import shutil
                shutil.move(part_files[0], mp4_name)
            elif len(part_files) > 1:
                concat_list = os.path.join(temp_dir, 'concat.txt')
                with open(concat_list, 'w') as f:
                    for pf in part_files:
                        f.write(f"file '{pf}'\n")
                cmd = ['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', concat_list, '-c', 'copy', mp4_name]
                subprocess.run(cmd, timeout=300)
            
            if os.path.exists(mp4_name):
                size_mb = os.path.getsize(mp4_name) / (1024*1024)
                print(f"  ✅ {mp4_name} ({size_mb:.1f}MB)")
            
            import shutil
            try: shutil.rmtree(temp_dir)
            except: pass
    
    # Cleanup ass files
    for f in os.listdir('.'):
        if f.endswith('.ass'):
            os.remove(f)
    
    print("\n=== ALL DONE ===")

if __name__ == '__main__':
    main()
