"""Trim SRT file to a time range, output SRT (not ASS)."""
import sys, re

def parse_srt_time(t):
    m = re.match(r'(\d+):(\d+):(\d+),(\d+)', t)
    if not m: return None
    return int(m.group(1))*3600 + int(m.group(2))*60 + int(m.group(3)) + int(m.group(4))/1000.0

def format_srt_time(s):
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = int(s % 60)
    ms = int(round((s % 1) * 1000))
    return f"{h:02d}:{m:02d}:{sec:02d},{ms:03d}"

srt_path = sys.argv[1]
start_time = float(sys.argv[2])
end_time = float(sys.argv[3])
output_path = sys.argv[4]

with open(srt_path, 'r', encoding='utf-8-sig') as f:
    content = f.read()

blocks = re.split(r'\n\s*\n', content.strip())
output = []
idx = 1

for block in blocks:
    lines = block.strip().split('\n')
    if len(lines) < 3:
        continue
    time_line = lines[1]
    m = re.match(r'(\d+:\d+:\d+,\d+)\s*-->\s*(\d+:\d+:\d+,\d+)', time_line)
    if not m:
        continue
    sub_start = parse_srt_time(m.group(1))
    sub_end = parse_srt_time(m.group(2))
    
    if sub_end < start_time or sub_start > end_time:
        continue
    
    new_start = max(0, sub_start - start_time)
    new_end = max(0, sub_end - start_time)
    
    text = '\n'.join(lines[2:])
    output.append(f"{idx}\n{format_srt_time(new_start)} --> {format_srt_time(new_end)}\n{text}\n")
    idx += 1

with open(output_path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(output))

print(f"Trimmed {len(output)} entries, {start_time}s - {end_time}s -> {output_path}")
