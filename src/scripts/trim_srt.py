import sys, re

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

srt_path = sys.argv[1]
start_time = float(sys.argv[2])
end_time = float(sys.argv[3])
output_path = sys.argv[4]

with open(srt_path, 'r', encoding='utf-8-sig') as f:
    content = f.read()

# Project standard ASS style from clip_sui_shiori.js
ass_header = """[Script Info]
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1920
PlayResY: 1080
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,52,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,40,40,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"""

blocks = re.split(r'\n\n+', content.strip())
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
    clipped_start = max(sub_start, start_time) - start_time
    clipped_end = min(sub_end, end_time) - start_time
    text = '\\N'.join(lines[2:]).replace('\n', '\\N')
    dialogues.append(f"Dialogue: 0,{format_ass_time(clipped_start)},{format_ass_time(clipped_end)},Default,,0,0,0,,{text}")

with open(output_path, 'w', encoding='utf-8') as f:
    f.write(ass_header + '\n')
    for d in dialogues:
        f.write(d + '\n')

print(f"Generated ASS with {len(dialogues)} dialogues, FontSize=52, Microsoft YaHei")
