import os, json, re, sys
SCRIPTS_DIR = os.path.join('D:', os.sep, 'workspace', 'myrepo', 'danmaku-to-summary-ts', 'src', 'scripts')
sys.path.insert(0, SCRIPTS_DIR)
from cover_generator import CoverGenerator

CLIPS_DIR = r'D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_18\own_stream_fun_clips'
state_path = os.path.join(CLIPS_DIR, 'upload_state.json')
review_path = os.path.join(CLIPS_DIR, 'REVIEW.md')
with open(state_path, 'r', encoding='utf-8') as f:
    state = json.load(f)
clips_map = {}
with open(review_path, 'r', encoding='utf-8') as f:
    for line in f:
        m = re.match(r'^(\d+)\.\s*(.+?)\s*\|\s*(\d{2}:\d{2}:\d{2})\s*\|\s*(\d{2}:\d{2}:\d{2})\s*\|?\s*(.+)?$', line.strip())
        if m:
            clips_map[int(m.group(1))] = {'title': m.group(2).strip(), 'path': m.group(5).strip() if m.group(5) else ''}
clips_map[19] = {'title':'戴夫游戏里冒出漂泊者名师，岁己念着念着开始瞎吹','path':os.path.join(CLIPS_DIR,'录制-25788785-20260618-195202-513-悠哉悠哉夜晚_merged_fun_19_050110.mp4')}

g = CoverGenerator()
for idx_str, info in sorted(state['done'].items(), key=lambda x:int(x[0])):
    idx = int(idx_str)
    clip = clips_map[idx]
    video_path = clip['path'] if os.path.isabs(clip['path']) else os.path.join(CLIPS_DIR, clip['path'])
    cover_file = os.path.join(CLIPS_DIR, f'cover_{idx:02d}_sui.jpg')
    text = re.sub(r'^【小岁】', '', info['title'])[:12]
    frame = os.path.join(CLIPS_DIR, f'_reframe_{idx:02d}.jpg')
    ts = g.find_key_frame(video_path, duration_ratio=0.2)
    g.extract_frame(video_path, ts, frame)
    g.add_text_to_cover(frame, text, output_path=cover_file, text_position='center')
    try:
        os.remove(frame)
    except:
        pass
    print(f'[{idx}] rewrote cover: {cover_file}')
