#!/usr/bin/env python3
"""测试JSON配置读取"""
import os
import sys
import json

# 添加scripts目录到路径
scripts_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src', 'scripts')
sys.path.insert(0, scripts_dir)

# 导入配置加载函数
from ai_comic_generator import load_config, get_room_reference_image

print("=" * 80)
print("测试配置加载")
print("=" * 80)

config = load_config()

# 检查 roomSettings
print("\nroomSettings中的房间:")
for room_id in config.get("roomSettings", {}):
    room_cfg = config["roomSettings"][room_id]
    print(f"\n房间 {room_id}:")
    print(f"  - anchorName: {room_cfg.get('anchorName', '未设置')}")
    print(f"  - fanName: {room_cfg.get('fanName', '未设置')}")
    print(f"  - referenceImage: {room_cfg.get('referenceImage', '未设置')}")
    print(f"  - characterDescription: {room_cfg.get('characterDescription', '未设置')}")

# 测试四个房间的参考图片
test_rooms = ['1713546334', '1713548468', '1986461465', '1741667419']
print("\n" + "=" * 80)
print("测试参考图片获取")
print("=" * 80)

for room_id in test_rooms:
    print(f"\n房间 {room_id}:")
    ref_img = get_room_reference_image(room_id)
    if ref_img:
        print(f"  ✓ 找到: {os.path.basename(ref_img)}")
    else:
        print(f"  ✗ 未找到")

print("\n" + "=" * 80)