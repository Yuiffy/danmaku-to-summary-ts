"""Pure upload description formatting; no account, network or filesystem access."""

import datetime
import re


def clean_generated_description(description, clip_title=''):
    """移除生成简介中将由上传器统一补充的模板字段和重复行。"""
    title = str(clip_title or '').strip()
    lines = str(description or '').replace('\r\n', '\n').replace('\r', '\n').split('\n')
    cleaned = []
    seen = set()

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            if cleaned and cleaned[-1] != '':
                cleaned.append('')
            continue

        if line == '直播切片' or (title and line == title):
            continue
        if re.match(r'^(?:来源|直播开始时间|切片时间)\s*[：:]', line):
            continue
        if re.match(r'^来自\s+.+\s+的直播《.*》.*录制时间', line):
            continue
        if re.match(r'^片段时间\s+\d{1,2}:\d{2}:\d{2}\s*[-－—~～至]\s*\d{1,2}:\d{2}:\d{2}', line):
            continue

        dedupe_key = re.sub(r'\s+', '', line)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        cleaned.append(line)

    while cleaned and cleaned[-1] == '':
        cleaned.pop()
    return '\n'.join(cleaned)


def split_source_description(source_desc):
    """从来源描述末尾拆出录制开始时间，避免把它误解为切片时间。"""
    source_text = str(source_desc or '').strip()
    recorded_at_match = re.search(
        r'(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?!.*\d)',
        source_text,
    )
    if not recorded_at_match:
        return source_text, ''

    recorded_at = f'{recorded_at_match.group(1)} {recorded_at_match.group(2)}'
    source_name = (
        source_text[:recorded_at_match.start()]
        + source_text[recorded_at_match.end():]
    ).strip().rstrip('，,;；-')
    return source_name, recorded_at


def build_clip_time_range(source_desc, start_sec, end_sec):
    """将直播内偏移换算成真实时钟时间；旧数据缺少开播时间时回退到偏移。"""
    _, recorded_at = split_source_description(source_desc)
    if recorded_at:
        try:
            live_start = datetime.datetime.strptime(
                recorded_at,
                '%Y-%m-%d %H:%M:%S',
            )
            clip_start = live_start + datetime.timedelta(seconds=start_sec)
            clip_end = live_start + datetime.timedelta(seconds=end_sec)
            return clip_start.strftime('%H:%M:%S'), clip_end.strftime('%H:%M:%S')
        except ValueError:
            pass

    def offset_to_clock(seconds):
        hours = seconds // 3600
        minutes = (seconds % 3600) // 60
        remaining_seconds = seconds % 60
        return f'{hours:02d}:{minutes:02d}:{remaining_seconds:02d}'

    return offset_to_clock(start_sec), offset_to_clock(end_sec)


def build_desc(clip_title, source_desc, start_str, dur_str, generated_description=''):
    """用预生成内容和统一的来源/时间字段构建视频简介。"""
    parts = dur_str.split(':')
    dur_sec = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    sparts = start_str.split(':')
    start_sec = int(sparts[0]) * 3600 + int(sparts[1]) * 60 + int(sparts[2])
    end_sec = start_sec + dur_sec
    clip_start_time, clip_end_time = build_clip_time_range(source_desc, start_sec, end_sec)
    start_min = start_sec // 60
    sections = []
    generated = clean_generated_description(generated_description, clip_title)
    generated, detail_separator, precision_detail = generated.partition('\n\n【AI精切说明】')
    if generated:
        sections.append(generated)
    source_name, recorded_at = split_source_description(source_desc)
    source_lines = []
    if source_name:
        source_lines.append(f"来源：{source_name}")
    if recorded_at:
        source_lines.append(f"直播开始时间：{recorded_at}")
    if source_lines:
        sections.append('\n'.join(source_lines))
    sections.append(
        f"切片时间：{clip_start_time} - {clip_end_time}"
        f"（直播开始后第{start_min}分钟）"
    )
    if detail_separator:
        sections.append('【AI精切说明】' + precision_detail)
    return '\n\n'.join(sections)
