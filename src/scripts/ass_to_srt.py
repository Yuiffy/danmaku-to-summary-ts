#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ASS字幕转SRT字幕工具
"""

import re
import sys
from pathlib import Path


def parse_ass_time(time_str):
    """解析ASS时间格式 H:MM:SS.CC"""
    # ASS格式: H:MM:SS.CC
    parts = time_str.split(':')
    hours = int(parts[0])
    minutes = int(parts[1])
    seconds_parts = parts[2].split('.')
    seconds = int(seconds_parts[0])
    centiseconds = int(seconds_parts[1]) if len(seconds_parts) > 1 else 0

    total_seconds = hours * 3600 + minutes * 60 + seconds + centiseconds / 100
    return total_seconds


def format_srt_time(seconds):
    """格式化为SRT时间格式 HH:MM:SS,mmm"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds - int(seconds)) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def clean_ass_text(text):
    """清理ASS文本，移除格式标签"""
    # 移除ASS格式标签，如 {\i1}, {\b1}, {\fs20}, {\c&HFFFFFF&} 等
    text = re.sub(r'\{[^}]*\}', '', text)
    # 移除换行符中的 \N, \n
    text = text.replace('\\N', '\n').replace('\\n', '\n')
    # 移除其他转义字符
    text = text.replace('\\h', ' ')
    return text.strip()


def ass_to_srt(ass_file_path, srt_file_path=None):
    """将ASS文件转换为SRT文件"""
    ass_path = Path(ass_file_path)
    if not ass_path.exists():
        print(f"❌ 文件不存在: {ass_file_path}")
        return False

    if srt_file_path is None:
        srt_file_path = ass_path.with_suffix('.srt')

    srt_path = Path(srt_file_path)

    print(f"📖 读取ASS文件: {ass_path}")

    with open(ass_path, 'r', encoding='utf-8-sig') as f:
        lines = f.readlines()

    # 解析ASS文件
    events_section = False
    subtitles = []
    start_idx = 1  # 默认值
    end_idx = 2    # 默认值
    text_idx = 9   # 默认值

    for line in lines:
        line = line.strip()

        if line == '[Events]':
            events_section = True
            continue

        if events_section and line.startswith('Format:'):
            # 解析Format行，确定各字段的索引
            format_line = line[7:].strip()
            fields = [f.strip() for f in format_line.split(',')]
            try:
                start_idx = fields.index('Start')
                end_idx = fields.index('End')
                text_idx = fields.index('Text')
                print(f"📋 Format字段: {fields}")
                print(f"📍 Start索引: {start_idx}, End索引: {end_idx}, Text索引: {text_idx}")
            except ValueError:
                print("❌ 无法解析Format行")
                return False
            continue

        if events_section and line.startswith('Dialogue:'):
            # 解析Dialogue行
            # Dialogue: 0,0:09:42.22,0:09:43.62,BottomCenter,,0,0,0,,哎我去怎么这么晚了
            # 注意：Text字段可能包含逗号，所以需要特殊处理
            dialogue_content = line[9:].strip()  # 移除"Dialogue:"

            # 找到前text_idx个逗号的位置（Text字段之前的逗号）
            comma_count = 0
            split_pos = 0
            for i, char in enumerate(dialogue_content):
                if char == ',':
                    comma_count += 1
                    if comma_count == text_idx:  # 找到第text_idx个逗号
                        split_pos = i
                        break

            if split_pos == 0:
                print(f"⚠️  找不到第{text_idx}个逗号: {dialogue_content[:50]}...")
                continue

            fields_part = dialogue_content[:split_pos]
            text_part = dialogue_content[split_pos + 1:]

            fields = [f.strip() for f in fields_part.split(',')]

            # fields应该有text_idx个元素（索引0到text_idx-1）
            if len(fields) < text_idx:
                print(f"⚠️  字段数量不足: {len(fields)} < {text_idx}")
                continue

            start_time = parse_ass_time(fields[start_idx])
            end_time = parse_ass_time(fields[end_idx])
            text = clean_ass_text(text_part)

            if text:  # 只添加非空字幕
                subtitles.append({
                    'start': start_time,
                    'end': end_time,
                    'text': text
                })
            else:
                print(f"⚠️  文本为空: {text_part[:30]}...")

    # 写入SRT文件
    print(f"✍️  写入SRT文件: {srt_path}")
    print(f"📊 共转换 {len(subtitles)} 条字幕")

    with open(srt_path, 'w', encoding='utf-8') as f:
        for i, sub in enumerate(subtitles, 1):
            f.write(f"{i}\n")
            f.write(f"{format_srt_time(sub['start'])} --> {format_srt_time(sub['end'])}\n")
            f.write(f"{sub['text']}\n\n")

    print(f"✅ 转换完成!")
    return True


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("用法: python ass_to_srt.py <ass文件路径> [srt输出路径]")
        sys.exit(1)

    ass_file = sys.argv[1]
    srt_file = sys.argv[2] if len(sys.argv) > 2 else None

    ass_to_srt(ass_file, srt_file)
