"""
批量给已上传的切片补封面大字
流程：截帧 → CoverGenerator 加大字 → update_cover 换上去
"""
import sys, os, json, re, subprocess, time

SCRIPTS_DIR = os.path.join('D:', os.sep, 'workspace', 'myrepo', 'danmaku-to-summary-ts', 'src', 'scripts')
sys.path.insert(0, SCRIPTS_DIR)

from cover_generator import CoverGenerator

CLIPS_DIR = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_18\own_stream_fun_clips"
SOURCE_FLV = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_18\录制-25788785-20260618-195202-513-悠哉悠哉夜晚_merged.flv"

# 从 upload_state.json 读 BV 号和标题
state_path = os.path.join(CLIPS_DIR, "upload_state.json")
with open(state_path, 'r', encoding='utf-8') as f:
    state = json.load(f)

# 从 REVIEW.md 读切片信息（序号→文件名映射）
review_path = os.path.join(CLIPS_DIR, "REVIEW.md")
clips_map = {}
with open(review_path, 'r', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        m = re.match(r'^(\d+)\.\s*(.+?)\s*\|\s*(\d{2}:\d{2}:\d{2})\s*\|\s*(\d{2}:\d{2}:\d{2})\s*\|?\s*(.+)?$', line)
        if m:
            idx = int(m.group(1))
            title = m.group(2).strip()
            path = m.group(5).strip() if m.group(5) else ''
            clips_map[idx] = {'title': title, 'path': path}

# clip 19 手动加
clips_map[19] = {
    'title': '戴夫游戏里冒出漂泊者名师，岁己念着念着开始瞎吹',
    'path': os.path.join(CLIPS_DIR, '录制-25788785-20260618-195202-513-悠哉悠哉夜晚_merged_fun_19_050110.mp4')
}

gen = CoverGenerator()

# 处理每个切片
for idx_str, info in sorted(state.get('done', {}).items(), key=lambda x: int(x[0])):
    idx = int(idx_str)
    bvid = info['bvid']
    full_title = info['title']
    # 去掉 【小岁】 前缀取短标题做封面文字
    short_title = re.sub(r'^【小岁】', '', full_title)
    # 封面文字取前12个字
    cover_text = short_title[:12]

    clip_info = clips_map.get(idx)
    if not clip_info:
        print(f"[{idx}] SKIP - 无切片信息")
        continue

    video_path = clip_info['path']
    if not os.path.isabs(video_path):
        video_path = os.path.join(CLIPS_DIR, video_path)

    if not os.path.exists(video_path):
        print(f"[{idx}] SKIP - 文件不存在: {video_path}")
        continue

    cover_file = os.path.join(CLIPS_DIR, f"cover_{idx:02d}_sui.jpg")
    if os.path.exists(cover_file):
        print(f"[{idx}] 封面已存在，SKIP: {cover_file}")
        continue

    print(f"[{idx}] 生成封面: {cover_text}")
    # 截帧（取视频 20% 位置）
    timestamp = gen.find_key_frame(video_path, duration_ratio=0.2)
    frame_path = os.path.join(CLIPS_DIR, f"_frame_{idx:02d}.jpg")
    gen.extract_frame(video_path, timestamp, frame_path)
    # 加大字
    gen.add_text_to_cover(frame_path, cover_text, output_path=cover_file, text_position='center')
    # 清理临时帧
    try: os.remove(frame_path)
    except: pass
    print(f"[{idx}] ✅ 封面已生成: {cover_file}")

# 19 号也补
if 19 not in state.get('done', {}):
    idx = 19
    clip_info = clips_map[19]
    video_path = clip_info['path']
    cover_file = os.path.join(CLIPS_DIR, f"cover_{idx:02d}_sui.jpg")
    if not os.path.exists(cover_file):
        short_title = clip_info['title']
        cover_text = short_title[:12]
        print(f"[{idx}] 生成封面: {cover_text}")
        timestamp = gen.find_key_frame(video_path, duration_ratio=0.2)
        frame_path = os.path.join(CLIPS_DIR, f"_frame_{idx:02d}.jpg")
        gen.extract_frame(video_path, timestamp, frame_path)
        gen.add_text_to_cover(frame_path, cover_text, output_path=cover_file, text_position='center')
        try: os.remove(frame_path)
        except: pass
        print(f"[{idx}] ✅ 封面已生成: {cover_file}")

print("\n=== 封面生成完成 ===")
print("接下来用 update_cover.py 逐个换封面")
