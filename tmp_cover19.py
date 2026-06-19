import os, sys
sys.path.insert(0, r'D:\workspace\myrepo\danmaku-to-summary-ts\src\scripts')
from cover_generator import CoverGenerator
CLIPS_DIR = r'D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_18\own_stream_fun_clips'
video_path = os.path.join(CLIPS_DIR, '录制-25788785-20260618-195202-513-悠哉悠哉夜晚_merged_fun_19_050110.mp4')
cover_file = os.path.join(CLIPS_DIR, 'cover_19_sui.jpg')
text = '戴夫里冒出漂泊者剧情'
g = CoverGenerator()
ts = g.find_key_frame(video_path, duration_ratio=0.2)
frame = os.path.join(CLIPS_DIR, '_reframe_19.jpg')
g.extract_frame(video_path, ts, frame)
g.add_text_to_cover(frame, text, output_path=cover_file, text_position='center')
print('done', cover_file)
