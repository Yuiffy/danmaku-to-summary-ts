"""
trim_srt_speaker.py — 支持说话人颜色区分的 ASS 字幕生成器
基于 trim_srt.py 项目标准样式 (BorderStyle=1, Outline=3, Shadow=1, FontSize=52)

用法:
  python trim_srt_speaker.py <srt> <start> <end> <output> [speaker_json] [clip_offset]

参数:
  srt          源 SRT 字幕文件
  start        裁剪起始秒 (在 SRT 时间轴上)
  end          裁剪结束秒
  output       输出 ASS 文件路径
  speaker_json (可选) speaker 时间线 JSON 文件，格式: [{"start_sec":..,"end_sec":..,"label":"shiori"},...]
               如果不提供，所有字幕用 Default 样式
  clip_offset  (可选) 字幕时间轴偏移量，默认=start

说话人颜色 (与 clip_sui_shiori.js 一致):
  shiori / 栞栞    → #6F4E37 咖啡色 &H00374E6F
  sui / 岁己        → #8B0000 暗红色 &H0000008B
  video / 其他      → #FFFFFF 白色   &H00FFFFFF

可以扩展 SPEAKER_STYLES 字典添加更多说话人。
"""
import sys, re, json, os

def parse_srt_time(t):
    m = re.match(r'(\d+):(\d+):(\d+),(\d+)', t)
    if not m: return None
    return int(m.group(1))*3600 + int(m.group(2))*60 + int(m.group(3)) + int(m.group(4))/1000.0

def format_ass_time(s):
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = int(s % 60)
    cs = int(round((s % 1) * 100))
    return f"{h}:{m:02d}:{sec:02d}.{cs:02d}"

def hex_to_ass(hex_color):
    """#RRGGBB → &H00BBGGRR"""
    r = int(hex_color[1:3], 16)
    g = int(hex_color[3:5], 16)
    b = int(hex_color[5:7], 16)
    return f"&H00{b:02X}{g:02X}{r:02X}"

# ============ 说话人样式定义 ============
# 颜色与 clip_sui_shiori.js 的 COLOR_* 常量一致
SPEAKER_STYLES = {
    'shiori':  {'name': '栞栞',  'color': hex_to_ass('#6F4E37')},  # 咖啡色
    'sui':     {'name': '岁己',  'color': hex_to_ass('#8B0000')},  # 暗红色
    'video':   {'name': '视频',  'color': hex_to_ass('#FFFFFF')},  # 白色
    'default': {'name': 'Default', 'color': hex_to_ass('#FFFFFF')},
}

def match_speaker(start_sec, end_sec, speaker_tl):
    """根据 speaker 时间线判断某条字幕是谁说的"""
    if not speaker_tl:
        return 'default'
    best_overlap = 0
    best_label = 'default'
    for seg in speaker_tl:
        seg_s = seg['start_sec']
        seg_e = seg['end_sec']
        overlap = min(end_sec, seg_e) - max(start_sec, seg_s)
        if overlap > best_overlap:
            best_overlap = overlap
            best_label = seg.get('label', 'default')
    return best_label

def main():
    if len(sys.argv) < 5:
        print(__doc__)
        sys.exit(1)

    srt_path = sys.argv[1]
    start_time = float(sys.argv[2])
    end_time = float(sys.argv[3])
    output_path = sys.argv[4]
    speaker_json_path = sys.argv[5] if len(sys.argv) > 5 else None
    clip_offset = float(sys.argv[6]) if len(sys.argv) > 6 else start_time

    # Load speaker timeline
    speaker_tl = None
    if speaker_json_path and os.path.exists(speaker_json_path):
        with open(speaker_json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        speaker_tl = data.get('segments', data) if isinstance(data, dict) else data

    # Parse SRT
    with open(srt_path, 'r', encoding='utf-8-sig') as f:
        content = f.read()
    blocks = re.split(r'\n\n+', content.strip())

    # Build ASS header with all speaker styles
    style_lines = []
    for key, info in SPEAKER_STYLES.items():
        color = info['color']
        name = info['name']
        style_lines.append(
            f"Style: {name},Microsoft YaHei,52,{color},&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,40,40,60,1"
        )

    # NOTE: trim_srt.py 用 PlayResX=1920 + FontSize=52，但在 1280x720 视频上实际很小
    # 参见 TOOLS.md: "FontSize=52 在 PlayResX=1920 下实际很小"
    # 修正: PlayResX/PlayResY 对齐视频实际分辨率
    ass_header = f"""[Script Info]
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1280
PlayResY: 720
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
""" + "\n".join(style_lines) + f"""

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"""

    dialogues = []
    for block in blocks:
        lines = block.strip().split('\n')
        if len(lines) < 3:
            continue
        time_match = re.match(r'(\d+:\d+:\d+,\d+)\s*-->\s*(\d+:\d+:\d+,\d+)', lines[1])
        if not time_match:
            continue
        sub_start = parse_srt_time(time_match.group(1))
        sub_end = parse_srt_time(time_match.group(2))
        if sub_start is None or sub_end is None:
            continue
        if sub_end <= start_time or sub_start >= end_time:
            continue
        clipped_start = max(sub_start, start_time) - clip_offset
        clipped_end = min(sub_end, end_time) - clip_offset

        # Determine speaker
        label = match_speaker(sub_start, sub_end, speaker_tl)
        style_name = SPEAKER_STYLES.get(label, SPEAKER_STYLES['default'])['name']

        text = '\\N'.join(lines[2:]).replace('\n', '\\N')
        # Escape ASS special chars
        text = text.replace('{', '').replace('}', '')
        dialogues.append((clipped_start, clipped_end, style_name, text))

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(ass_header + '\n')
        for cs, ce, style, text in dialogues:
            f.write(f"Dialogue: 0,{format_ass_time(cs)},{format_ass_time(ce)},{style},,0,0,0,,{text}\n")

    # Stats
    from collections import Counter
    style_counts = Counter(d[2] for d in dialogues)
    print(f"Generated ASS: {len(dialogues)} dialogues, FontSize=52, BorderStyle=1, Outline=3")
    print(f"Speaker distribution: {dict(style_counts)}")

if __name__ == '__main__':
    main()
