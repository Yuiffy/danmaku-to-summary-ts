#!/usr/bin/env python
"""
B站批量切片投稿脚本（防重复版）

用法:
  python batch_upload.py --review <REVIEW.md路径> [选项]

选项:
  --review     REVIEW.md 路径（必需）
  --source     来源描述（如：岁己SUI 直播《悠哉悠哉夜晚》2026-06-18）
  --tags       标签（逗号分隔，默认：小岁,虚拟主播,直播切片,岁AI切片）
  --prefix     标题前缀（默认：【小岁】）
  --tid        分区（默认：21=日常）
  --delay      每次上传间隔秒数（默认：30）
  --skip       跳过指定序号（逗号分隔，如：1,2,3）
  --only       只上传指定序号（逗号分隔，如：5,6,7）
  --force      允许本次明确授权的修正版跳过同标题查重并重新投稿
  --dry-run    只查重不实际上传
  --state      状态文件路径（默认：同目录下 upload_state.json）
  --rate-limit-wait     B站提示上传过快后的等待秒数（默认：120）
  --rate-limit-retries  B站提示上传过快后的最大重试次数（默认：5）

核心防重复逻辑:
  1. 上传前：通过搜索 API + member archives 实时列表双重查同名稿件
  2. 同标题只记录为 title_conflict，不写入已上传状态，等待人工核对
  3. 只有显式 --force 才跳过同标题查重，允许授权的修正版重新投稿
  4. 406 错误：不盲目重试，先查 member archives；若 B站提示上传过快则等待后重试
  5. 状态持久化：每传完一个立即写 state，中途 kill 也能保留记录
  6. member archives 是实时的（不走搜索索引），作为查重主力的可靠来源
"""

import sys
import os
import json
import asyncio
import argparse
import re
import time
import datetime
import subprocess

INTERNAL_REVIEW_LABEL_RE = re.compile(r'^\[(?:模型全量|模型分块|弹幕热度|本地规则)\]\s*')
REVIEW_SCORE_SUFFIX_RE = re.compile(r'\s+\|\s+\d+(?:\.\d+)?分\s*$')

# 添加项目路径
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(PROJECT_ROOT, 'src', 'scripts'))

from config_loader import get_config, find_secrets_path
from bilibili_upload import attach_video_to_collection, extract_room_id, get_collection_section_id
from bilibili_api import Credential, video_uploader, Picture, video, get_client
import requests

ACCOUNT_MID = 412141275
DEFAULT_RATE_LIMIT_WAIT = 120
DEFAULT_RATE_LIMIT_RETRIES = 5


def infer_room_id(clips, explicit_room_id=None):
    """Resolve the source room from an explicit option or generated media path."""
    if explicit_room_id:
        return str(explicit_room_id).strip()
    for clip in clips or []:
        room_id = extract_room_id(clip.get('path'))
        if room_id:
            return room_id
    return None


def strip_review_score_suffix(value):
    """Remove the recommendation score appended after a REVIEW media path."""
    return REVIEW_SCORE_SUFFIX_RE.sub('', str(value or '')).strip()


def validate_video_stream(filepath):
    """Reject media where the container duration is carried by audio only."""
    try:
        probe = subprocess.run(
            [
                'ffprobe', '-v', 'error', '-select_streams', 'v:0',
                '-show_entries', 'stream=duration,nb_frames',
                '-of', 'json', filepath,
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
        streams = (json.loads(probe.stdout).get('streams') or [])
        if not streams:
            return False, 'no video stream'
        stream = streams[0]
        video_duration = float(stream.get('duration') or 0)
        frames = int(stream.get('nb_frames') or 0)
        if video_duration < 3 or frames < 10:
            return False, f'video too short ({video_duration:.2f}s, {frames} frames)'
        return True, ''
    except Exception as error:
        return False, f'video validation failed: {error}'


def build_credential(room_id=None, streamer_name=None, source_desc=None, prefix=None):
    secrets_path = find_secrets_path()
    with open(secrets_path, 'r', encoding='utf-8-sig') as f:
        secrets = json.load(f)
    cookie_str = secrets.get('bilibili', {}).get('cookie', '')
    config = get_config()
    collection_section_id = get_collection_section_id(
        config,
        room_id=room_id,
        streamer_name=streamer_name,
        source_desc=source_desc,
        prefix=prefix,
    )
    if collection_section_id:
        print(f"[INFO] 自动加入合集 section_id={collection_section_id}")
    if not cookie_str:
        print("[ERROR] 未找到B站Cookie")
        sys.exit(1)
    cookies = {}
    for item in cookie_str.split(';'):
        item = item.strip()
        if '=' in item:
            k, v = item.split('=', 1)
            cookies[k.strip()] = v.strip()
    return Credential(
        sessdata=cookies.get('SESSDATA', ''),
        bili_jct=cookies.get('bili_jct', ''),
        buvid3=cookies.get('buvid3', ''),
        dedeuserid=cookies.get('DedeUserID', str(ACCOUNT_MID)),
        ac_time_value=cookies.get('ac_time_value', ''),
    )


def fetch_member_archive_rows(cookie_str, mid=ACCOUNT_MID, pages=5):
    """通过 member API 实时查询已上传稿件列表（零延迟，不走搜索索引）。"""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookie_str,
        'Referer': 'https://member.bilibili.com/'
    }
    rows = []
    for pn in range(1, pages + 1):
        try:
            r = requests.get(
                'https://member.bilibili.com/x/web/archives',
                params={'mid': mid, 'pn': pn, 'ps': 50, 'typeid': 0, 'status': 'all'},
                headers=headers,
                timeout=15,
            )
            data = r.json()
            if data.get('code') != 0:
                print(f"  [WARN] member archives API 返回 code={data.get('code')}: {data.get('message', '')}")
                break
            audits = (data.get('data') or {}).get('arc_audits') or []
            if not audits:
                break
            for a in audits:
                arc = a.get('Archive', {})
                title = arc.get('title', '')
                bvid = arc.get('bvid', '')
                if title and bvid:
                    rows.append({
                        'title': title,
                        'bvid': bvid,
                        'aid': arc.get('aid'),
                        'state': arc.get('state'),
                        'pubdate': arc.get('pubdate') or arc.get('ctime') or 0,
                    })
        except Exception as e:
            print(f"  [WARN] member archives 第{pn}页失败: {e}")
            break
    return rows


def fetch_member_archives(cookie_str, mid=ACCOUNT_MID, pages=5, warn_duplicate_titles=None):
    """返回 {title: bvid} 字典；同标题多条时保留最新一条并打印告警。"""
    rows = fetch_member_archive_rows(cookie_str, mid=mid, pages=pages)
    warn_duplicate_titles = set(warn_duplicate_titles or [])
    by_title = {}
    for row in rows:
        by_title.setdefault(row['title'], []).append(row)

    existing = {}
    for title, items in by_title.items():
        items.sort(key=lambda x: int(x.get('pubdate') or 0), reverse=True)
        existing[title] = items[0]['bvid']
        if len(items) > 1 and title in warn_duplicate_titles:
            bvids = ', '.join(f"{item['bvid']}(state={item.get('state')})" for item in items[:5])
            print(f"  [DUP-WARN] 创作中心发现同标题 {len(items)} 条: {title[:60]} -> {bvids}")
    return existing


def search_existing_titles(cookie_str, keyword="小岁"):
    """通过搜索 API 查找已上传的视频标题，用于查重。"""
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookie_str,
        'Referer': 'https://search.bilibili.com'
    }
    existing = {}  # title -> bvid
    for page in range(1, 4):
        try:
            r = requests.get(
                'https://api.bilibili.com/x/web-interface/search/type',
                params={
                    'search_type': 'video',
                    'keyword': keyword,
                    'order': 'pubdate',
                    'page': page,
                },
                headers=headers,
                timeout=15,
            )
            data = r.json()
            if data.get('code') != 0:
                break
            results = (data.get('data') or {}).get('result') or []
            if not results:
                break
            for item in results:
                # 只保留本账号的
                if item.get('mid') == ACCOUNT_MID:
                    title = re.sub(r'<[^>]+>', '', item.get('title', ''))
                    existing[title] = item.get('bvid', '')
            time.sleep(1)  # 搜索间隔
        except Exception as e:
            print(f"  [WARN] 搜索第{page}页失败: {e}")
            break
    return existing


async def probe_upload_available(credential):
    """Return (available, message) from Bilibili preupload rate-limit probe."""
    try:
        session = get_client()
        response = await session.request(
            method='GET',
            url='https://member.bilibili.com/preupload',
            params={
                'profile': 'ugcfx/bup',
                'name': 'rate_limit_probe.mp4',
                'size': 12500000,
                'r': 'upos',
                'ssl': '0',
                'version': '2.14.0',
                'build': '2100400',
                'upcdn': 'bda2',
                'probe_version': 20221109,
            },
            cookies=await credential.get_buvid_cookies(),
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.bilibili.com',
            },
        )
        status_code = getattr(response, 'code', 200)
        raw_text = getattr(response, 'raw_text', None) or str(response)
        if status_code == 406:
            try:
                raw = getattr(response, 'raw', b'')
                data = json.loads(raw.decode('utf-8', errors='ignore')) if raw else {}
                return False, data.get('info') or data.get('message') or raw_text[:200]
            except Exception:
                return False, raw_text[:200]
        if status_code >= 400:
            return False, f'preupload HTTP {status_code}: {raw_text[:200]}'
        return True, ''
    except Exception as e:
        return False, f'preupload probe failed: {e}'


def is_rate_limit_message(message):
    text = str(message or '')
    return '上传视频过快' in text or '稍作休息' in text or 'too fast' in text.lower()


def same_path(a, b):
    if not a or not b:
        return False
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def state_record_matches_upload(record, full_title, media_path=''):
    if not isinstance(record, dict):
        return False
    # A title-only match is not proof that this local media was uploaded.
    # Older state files used these sources as if they were successful uploads;
    # force the next run through the explicit title-conflict path instead.
    if record.get('source') in ('search_dup', 'already_exists', 'title_conflict'):
        return False
    if record.get('bvid') or record.get('aid') or record.get('cid'):
        recorded_path = record.get('mediaPath') or ''
        return bool(recorded_path and media_path and same_path(recorded_path, media_path))
    return False


def record_title_conflict(state, clip, full_title, bvid='', online_title='', reason='', review_path=''):
    """Persist a title collision without pretending the local media succeeded."""
    clip_key = str(clip['idx'])
    state.setdefault('done', {}).pop(clip_key, None)
    state.setdefault('got_406', {}).pop(clip_key, None)
    state.setdefault('title_conflicts', {})[clip_key] = {
        'title': full_title,
        'onlineTitle': online_title or full_title,
        'bvid': bvid or '',
        'source': 'title_conflict',
        'reason': reason or '线上已有同标题稿件，尚未核对是否为同一媒体',
        'reviewPath': review_path or clip.get('reviewPath') or '',
        'mediaPath': clip.get('path') or '',
    }


def fetch_archive_detail(cookie_str, bvid):
    """Fetch stable archive identifiers and current online title for an uploaded video."""
    if not bvid:
        return {}
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookie_str,
        'Referer': 'https://member.bilibili.com/'
    }
    try:
        r = requests.get(
            'https://member.bilibili.com/x/vupre/web/archive/view',
            params={'bvid': bvid, 'topic_grey': 1},
            headers=headers,
            timeout=15,
        )
        data = r.json()
        if data.get('code') != 0:
            print(f"  [WARN] archive detail 返回 code={data.get('code')}: {data.get('message', '')}")
            return {}
        payload = data.get('data') or {}
        archive = payload.get('archive') or {}
        videos = payload.get('videos') or []
        first_video = videos[0] if videos else {}
        return {
            'bvid': archive.get('bvid') or bvid,
            'aid': archive.get('aid'),
            'cid': first_video.get('cid'),
            'onlineTitle': archive.get('title') or '',
        }
    except Exception as e:
        print(f"  [WARN] 查询稿件详情失败 {bvid}: {e}")
        return {}


def enrich_upload_result(result, cookie_str):
    if not isinstance(result, dict) or not result.get('bvid'):
        return result
    detail = fetch_archive_detail(cookie_str, result.get('bvid'))
    for key in ('bvid', 'aid', 'cid', 'onlineTitle'):
        if detail.get(key):
            result[key] = detail[key]
    return result


async def wait_for_upload_available(credential, wait_seconds, max_retries):
    for attempt in range(max_retries + 1):
        available, message = await probe_upload_available(credential)
        if available:
            if attempt > 0:
                print("  [rate-limit] preupload 已恢复，继续上传")
            return True, ''

        if not is_rate_limit_message(message):
            return False, message

        if attempt >= max_retries:
            return False, message

        print(f"  [rate-limit] {message}；等待 {wait_seconds}s 后重试 preupload ({attempt + 1}/{max_retries})")
        await asyncio.sleep(wait_seconds)

    return False, 'preupload unavailable'


def parse_review(review_path):
    """解析 REVIEW.md，提取切片列表。
    预期格式: 序号. 标题 | 开始时间 | 时长 | 文件路径，来源单独占一行
    """
    clips = []
    selection_source_by_idx = {}
    cover_by_idx = {}
    with open(review_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            # 匹配 "1. 标题 | 00:44:48 | 00:04:19 | 路径"
            m = re.match(r'^(\d+)\.\s*(.+?)\s*\|\s*(\d{2}:\d{2}:\d{2})\s*\|\s*(\d{2}:\d{2}:\d{2})\s*\|?\s*(.+)?$', line)
            if m:
                idx = int(m.group(1))
                title = INTERNAL_REVIEW_LABEL_RE.sub('', m.group(2).strip(), count=1)
                start = m.group(3).strip()
                dur = m.group(4).strip()
                path = strip_review_score_suffix(m.group(5)) if m.group(5) else ''
                clips.append({
                    'idx': idx,
                    'title': title,
                    'start': start,
                    'duration': dur,
                    'path': path,
                    'cover': '',
                })
                continue
            source_match = re.match(r'^\s*来源:\s*(.+?)\s*$', line)
            if source_match and clips:
                selection_source_by_idx[clips[-1]['idx']] = source_match.group(1).strip()
                continue
            cover_match = re.match(r'^\s*封面:\s*(.+?)\s*$', line)
            if cover_match and clips:
                cover_by_idx[clips[-1]['idx']] = cover_match.group(1).strip()

    for clip in clips:
        clip['selectionSource'] = selection_source_by_idx.get(clip['idx'], '')
        clip['cover'] = cover_by_idx.get(clip['idx'], '')
    return clips


def find_existing_cover(clip):
    """Prefer generated title covers over a plain frame grab."""
    explicit = (clip.get('cover') or '').strip()
    if explicit and os.path.exists(explicit):
        return explicit

    filepath = clip.get('path') or ''
    if filepath:
        base, _ = os.path.splitext(filepath)
        candidates = [
            f'{base}_cover.jpg',
            f'{base}_cover.png',
            os.path.join(os.path.dirname(filepath), f'cover_{clip["idx"]:02d}_sui.jpg'),
            os.path.join(os.path.dirname(filepath), f'cover_{clip["idx"]:02d}.jpg'),
        ]
        metadata_path = f'{base}.json'
        if os.path.exists(metadata_path):
            try:
                with open(metadata_path, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)
                cover_path = ((metadata.get('output') or {}).get('coverPath') or '').strip()
                if cover_path:
                    candidates.insert(0, cover_path)
            except Exception:
                pass
        for candidate in candidates:
            if candidate and os.path.exists(candidate):
                return candidate
    return None


def load_generated_description(clip):
    """读取切片阶段生成的简介，优先使用结构化元数据。"""
    filepath = (clip.get('path') or '').strip()
    if not filepath:
        return ''

    base, _ = os.path.splitext(filepath)
    metadata_path = f'{base}.json'
    if os.path.exists(metadata_path):
        try:
            with open(metadata_path, 'r', encoding='utf-8') as f:
                metadata = json.load(f)
            description = ((metadata.get('copy') or {}).get('description') or '').strip()
            if description:
                return description
        except (OSError, UnicodeError, json.JSONDecodeError, AttributeError):
            pass

    copy_path = f'{base}_投稿文案.md'
    if os.path.exists(copy_path):
        try:
            with open(copy_path, 'r', encoding='utf-8') as f:
                content = f.read()
            match = re.search(r'^##\s*简介\s*$\s*(.*?)(?=^##\s|\Z)', content, re.MULTILINE | re.DOTALL)
            if match:
                return match.group(1).strip()
        except (OSError, UnicodeError):
            pass
    return ''


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
    return '\n\n'.join(sections)


async def upload_one(clip, credential, prefix, tags, tid, source_desc, collection_section_id=None):
    """上传单个切片，返回结果 dict"""
    full_title = f"{prefix}{clip['title']}"
    filepath = clip['path']

    if not filepath or not os.path.exists(filepath):
        print(f"  [SKIP] 文件不存在: {filepath}")
        return {'idx': clip['idx'], 'title': full_title, 'status': 'no_file'}

    video_ok, video_error = validate_video_stream(filepath)
    if not video_ok:
        print(f"  [ERROR] 拒绝上传异常视频: {video_error}")
        return {'idx': clip['idx'], 'title': full_title, 'status': 'invalid_video', 'error': video_error}

    generated_description = load_generated_description(clip)
    desc = build_desc(
        clip['title'],
        source_desc,
        clip['start'],
        clip['duration'],
        generated_description,
    )
    size_mb = os.path.getsize(filepath) / (1024 * 1024)
    print(f"  文件: {os.path.basename(filepath)} ({size_mb:.1f}MB)")

    # 优先使用标准流程生成的标题封面；没有时才临时截第一帧兜底。
    cover_tmp = os.path.join(os.path.dirname(filepath), f'_tmp_cover_{clip["idx"]}.jpg')
    cover_path = find_existing_cover(clip)
    cleanup_cover_tmp = False
    try:
        if cover_path:
            print(f"  封面: {os.path.basename(cover_path)}")
            cover = Picture.from_file(cover_path)
        else:
            subprocess.run([
                'ffmpeg', '-i', filepath, '-vframes', '1',
                '-q:v', '2', cover_tmp, '-y', '-loglevel', 'error'
            ], check=True, timeout=30)
            cover_path = cover_tmp
            cleanup_cover_tmp = True
            print(f"  [WARN] 未找到标题封面，临时截取第一帧")
            cover = Picture.from_file(cover_tmp)
    except Exception as e:
        print(f"  [WARN] 截取封面失败: {e}")
        cover = None

    if cover is None:
        print(f"  [ERROR] 无法创建封面，跳过")
        return {'idx': clip['idx'], 'title': full_title, 'status': 'no_cover'}

    # 创建投稿页
    page = video_uploader.VideoUploaderPage(path=filepath, title=full_title, description=desc)

    try:
        meta = video_uploader.VideoMeta(
            tid=tid, title=full_title, desc=desc, cover=cover,
            tags=tags, original=False, source="直播切片",
        )
        uploader = video_uploader.VideoUploader(
            pages=[page], meta=meta, credential=credential,
        )
        print(f"  开始上传...")
        result = await uploader.start()

        if result and isinstance(result, dict) and result.get('bvid'):
            bvid = result['bvid']
            print(f"  ✅ 成功: {bvid}")
            # 清理临时封面
            if cleanup_cover_tmp:
                try: os.remove(cover_tmp)
                except: pass
            # VideoUploader commonly returns only a bvid.  Do not attach the
            # collection here: aid/cid are frequently unavailable until the
            # archive detail endpoint catches up.  upload_one_guarded enriches
            # this result first, then attaches it.
            upload_result = {
                'idx': clip['idx'],
                'title': full_title,
                'status': 'ok',
                'bvid': bvid,
                'cover': cover_path,
            }
            for key in ('aid', 'cid', 'collectionSectionId', 'collectionStatus', 'collectionError'):
                if key in result:
                    upload_result[key] = result[key]
            return upload_result
        else:
            print(f"  ❌ 上传返回无效结果: {result}")
            if cleanup_cover_tmp:
                try: os.remove(cover_tmp)
                except: pass
            return {'idx': clip['idx'], 'title': full_title, 'status': 'fail'}
    except Exception as e:
        err = str(e)
        if cleanup_cover_tmp:
            try: os.remove(cover_tmp)
            except: pass
        if '406' in err:
            print(f"  ❌ 406 错误（可能已上传成功，需查搜索确认）")
            return {'idx': clip['idx'], 'title': full_title, 'status': 'got_406'}
        else:
            print(f"  ❌ 错误: {err[:200]}")
            return {'idx': clip['idx'], 'title': full_title, 'status': 'error', 'error': err[:200]}


async def upload_one_guarded(
    clip,
    credential,
    prefix,
    tags,
    tid,
    source_desc,
    cookie_str,
    rate_limit_wait,
    rate_limit_retries,
    collection_section_id=None,
    allow_duplicate_title=False,
):
    full_title = f"{prefix}{clip['title']}"

    async def enrich_and_attach(result):
        """Resolve archive ids before attaching to a collection.

        A newly submitted archive often has no ``aid``/``cid`` in the uploader
        response, even though the member archive detail endpoint is ready a few
        moments later.  Attaching before this step silently skipped every such
        upload.
        """
        result = enrich_upload_result(result, cookie_str)
        if result.get('bvid'):
            await attach_video_to_collection(
                result,
                credential,
                collection_section_id=collection_section_id,
            )
        return result

    for attempt in range(rate_limit_retries + 1):
        if not allow_duplicate_title:
            archives_before = fetch_member_archives(cookie_str, warn_duplicate_titles={full_title})
            if full_title in archives_before:
                bvid = archives_before[full_title]
                print(f"  [CONFLICT] 上传前发现同标题已存在，需人工核对: {bvid}")
                return enrich_upload_result({
                    'idx': clip['idx'], 'title': full_title, 'status': 'title_conflict', 'bvid': bvid,
                }, cookie_str)
        else:
            print(f"  [FORCE] 跳过上传前同标题查重: {full_title}")

        available, message = await wait_for_upload_available(credential, rate_limit_wait, rate_limit_retries)
        if not available:
            print(f"  [STOP] preupload 暂不可用: {message}")
            return {'idx': clip['idx'], 'title': full_title, 'status': 'rate_limited', 'error': message}

        if attempt > 0:
            print(f"  [retry] 第 {attempt + 1} 次尝试上传")

        result = await upload_one(
            clip,
            credential,
            prefix,
            tags,
            tid,
            source_desc,
            collection_section_id=collection_section_id,
        )
        if result.get('status') == 'ok' and result.get('bvid'):
            result = await enrich_and_attach(result)
        if result['status'] != 'got_406':
            return result

        print(f"  [406处理] 等待 15 秒后查 member archives 确认...")
        await asyncio.sleep(15)
        archives_now = fetch_member_archives(cookie_str, warn_duplicate_titles={full_title})
        if full_title in archives_now:
            bvid = archives_now[full_title]
            print(f"  ✅ 406 实际已上传成功: {bvid}")
            result['status'] = 'ok_after_406'
            result['bvid'] = bvid
            return await enrich_and_attach(result)

        available, message = await probe_upload_available(credential)
        if not is_rate_limit_message(message):
            print(f"  ❓ 406 后未找到同标题，且 preupload 未明确返回限速: {message}")
            return result

        if attempt >= rate_limit_retries:
            print(f"  ❓ 仍被 B站限速，已达到重试上限")
            return {'idx': clip['idx'], 'title': full_title, 'status': 'rate_limited', 'error': message}

        print(f"  [rate-limit] {message}；等待 {rate_limit_wait}s 后再次确认/重试")
        await asyncio.sleep(rate_limit_wait)
        archives_after_wait = fetch_member_archives(cookie_str, warn_duplicate_titles={full_title})
        if full_title in archives_after_wait:
            bvid = archives_after_wait[full_title]
            print(f"  ✅ 等待后确认已入库: {bvid}")
            result = {'idx': clip['idx'], 'title': full_title, 'status': 'ok_after_406', 'bvid': bvid}
            return await enrich_and_attach(result)

    return {'idx': clip['idx'], 'title': full_title, 'status': 'rate_limited'}


async def main():
    parser = argparse.ArgumentParser(description='B站批量切片投稿（防重复版）')
    parser.add_argument('--review', required=True, help='REVIEW.md 路径')
    parser.add_argument('--source', required=True, help='来源描述')
    parser.add_argument('--tags', default='小岁,虚拟主播,直播切片,岁AI切片', help='标签')
    parser.add_argument('--prefix', default='【小岁】', help='标题前缀')
    parser.add_argument('--streamer-name', default=None, help='主播名，用于合集路由')
    parser.add_argument('--room-id', default=None, help='直播间号，用于合集路由；未提供时从媒体路径识别')
    parser.add_argument('--tid', type=int, default=21, help='分区ID')
    parser.add_argument('--delay', type=int, default=30, help='上传间隔秒数')
    parser.add_argument('--skip', default='', help='跳过序号（逗号分隔）')
    parser.add_argument('--only', default='', help='只传指定序号（逗号分隔）')
    parser.add_argument('--force', action='store_true', help='允许明确授权的修正版跳过同标题查重并重新投稿')
    parser.add_argument('--dry-run', action='store_true', help='只查重不上传')
    parser.add_argument('--state', default=None, help='状态文件路径')
    parser.add_argument('--rate-limit-wait', type=int, default=DEFAULT_RATE_LIMIT_WAIT, help='B站提示上传过快后的等待秒数')
    parser.add_argument('--rate-limit-retries', type=int, default=DEFAULT_RATE_LIMIT_RETRIES, help='B站提示上传过快后的最大重试次数')
    args = parser.parse_args()

    tags = [t.strip() for t in args.tags.split(',') if t.strip()]
    skip_set = set()
    if args.skip:
        skip_set = {int(x) for x in args.skip.split(',') if x.strip()}
    only_set = None
    if args.only:
        only_set = {int(x) for x in args.only.split(',') if x.strip()}

    # 解析 REVIEW.md
    clips = parse_review(args.review)
    if not clips:
        print("[ERROR] REVIEW.md 中未找到切片条目")
        sys.exit(1)
    print(f"[INFO] 从 REVIEW.md 解析到 {len(clips)} 个切片")
    review_titles = {f"{args.prefix}{clip['title']}" for clip in clips}

    # 状态文件
    state_path = args.state or os.path.join(os.path.dirname(args.review), 'upload_state.json')
    state = {}
    if os.path.exists(state_path):
        with open(state_path, 'r', encoding='utf-8') as f:
            state = json.load(f)
        print(f"[INFO] 加载状态文件: {state_path}（已有 {len(state.get('done', {}))} 个记录）")

    # 读取 cookie
    secrets_path = find_secrets_path()
    with open(secrets_path, 'r', encoding='utf-8-sig') as f:
        secrets = json.load(f)
    cookie_str = secrets.get('bilibili', {}).get('cookie', '')

    # === 第1步：查重（member archives 实时列表 + 搜索 API 双重查）===
    print(f"\n=== 第1步：查重 ===")
    # member archives 是实时的，不走搜索索引，作为主力查重来源
    existing = fetch_member_archives(cookie_str, warn_duplicate_titles=review_titles)
    print(f"[INFO] member archives 查到 {len(existing)} 个稿件")
    # 搜索 API 作为补充（能查到更早的历史稿件）
    search_keyword = args.prefix.strip('【】')
    search_existing = search_existing_titles(cookie_str, search_keyword)
    print(f"[INFO] 搜索 API 查到本账号 {len(search_existing)} 个视频")
    # 合并：member archives 优先（实时）
    search_existing.update(existing)
    existing = search_existing
    print(f"[INFO] 合并后共 {len(existing)} 个已知稿件")

    # 过滤要上传的切片
    to_upload = []
    title_conflicts = []
    skipped_state = []
    skipped_arg = []
    skipped_review_dup = []
    planned_titles = set()
    for clip in clips:
        full_title = f"{args.prefix}{clip['title']}"

        # 跳过参数
        if clip['idx'] in skip_set:
            skipped_arg.append(clip)
            continue
        if only_set and clip['idx'] not in only_set:
            skipped_arg.append(clip)
            continue

        # 状态文件查重
        done_record = state.get('done', {}).get(str(clip['idx']))
        if done_record is not None and not args.force:
            if state_record_matches_upload(done_record, full_title, clip.get('path') or ''):
                skipped_state.append(clip)
                continue
            old_title = done_record.get('title') if isinstance(done_record, dict) else ''
            print(f"  [{clip['idx']}] WARN 忽略标题不匹配的旧状态: {old_title} != {full_title}")
        elif done_record is not None and args.force:
            print(f"  [{clip['idx']}] [FORCE] 忽略已有状态，准备重新投稿: {full_title}")

        if full_title in planned_titles:
            print(f"  [{clip['idx']}] SKIP (REVIEW 内同标题重复): {full_title}")
            skipped_review_dup.append(clip)
            continue

        # 搜索查重
        if full_title in existing and not args.force:
            bvid = existing[full_title]
            existing_result = enrich_upload_result(
                {'idx': clip['idx'], 'title': full_title, 'status': 'title_conflict', 'bvid': bvid},
                cookie_str,
            )
            print(f"  [{clip['idx']}] CONFLICT (线上同标题，未确认媒体): {full_title} -> {bvid}")
            title_conflicts.append(clip)
            record_title_conflict(
                state,
                clip,
                full_title,
                bvid=existing_result.get('bvid') or bvid,
                online_title=existing_result.get('onlineTitle') or full_title,
                review_path=args.review,
            )
            continue
        if full_title in existing and args.force:
            print(f"  [{clip['idx']}] [FORCE] 忽略线上同标题稿件，准备重新投稿: {existing[full_title]}")

        to_upload.append(clip)
        planned_titles.add(full_title)

    print(
        f"\n[INFO] 同标题冲突(待核对): {len(title_conflicts)} | "
        f"跳过(状态已完成): {len(skipped_state)} | "
        f"跳过(REVIEW重复): {len(skipped_review_dup)} | "
        f"跳过(参数): {len(skipped_arg)} | 待上传: {len(to_upload)}"
    )

    # 保存查重结果到状态
    with open(state_path, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

    if args.dry_run:
        print("\n[DRY-RUN] 不实际上传。")
        for clip in to_upload:
            print(f"  [{clip['idx']}] {args.prefix}{clip['title']}")
        return 2 if title_conflicts else 0

    if not to_upload:
        print("\n[INFO] 没有需要上传的切片。")
        return 2 if title_conflicts else 0

    room_id = infer_room_id(to_upload, args.room_id)
    if room_id:
        print(f"[INFO] 根据切片媒体路径识别直播间: {room_id}")
    else:
        print("[WARN] 未识别到直播间号，将按来源文本回退判断合集")

    credential = build_credential(
        room_id=room_id,
        streamer_name=args.streamer_name,
        source_desc=args.source,
        prefix=args.prefix,
    )
    upload_available, upload_limit_message = await wait_for_upload_available(
        credential,
        max(30, args.rate_limit_wait),
        max(0, args.rate_limit_retries),
    )
    if not upload_available:
        print(f"\n[ERROR] B站 preupload 当前不可用：{upload_limit_message}")
        print("[ERROR] 已达到等待/重试上限，停止本批次。稍后重试即可复用当前状态文件。")
        return

    # === 第2步：上传 ===
    print(f"\n=== 第2步：开始上传（间隔 {args.delay}s）===")
    print("[INFO] 凭证已创建\n")

    collection_section_id = None
    try:
        collection_section_id = get_collection_section_id(
            room_id=room_id,
            streamer_name=args.streamer_name,
            source_desc=args.source,
            prefix=args.prefix,
        )
    except Exception as e:
        print(f"[WARN] 获取合集 section_id 失败，跳过合集：{e}")

    results = []
    for i, clip in enumerate(to_upload):
        full_title = f"{args.prefix}{clip['title']}"
        print(f"[{i+1}/{len(to_upload)}] #{clip['idx']} {full_title}")

        result = await upload_one_guarded(
            clip,
            credential,
            args.prefix,
            tags,
            args.tid,
            args.source,
            cookie_str,
            max(30, args.rate_limit_wait),
            max(0, args.rate_limit_retries),
            collection_section_id,
            allow_duplicate_title=args.force,
        )
        results.append(result)

        # 记录到状态
        if result['status'] in ('ok', 'ok_after_406'):
            state.setdefault('done', {})[str(clip['idx'])] = {
                'title': full_title,
                'submittedTitle': full_title,
                'onlineTitle': result.get('onlineTitle') or '',
                'bvid': result['bvid'],
                'aid': result.get('aid'),
                'cid': result.get('cid'),
                'source': result['status'],
                'cover': result.get('cover') or find_existing_cover(clip) or '',
                'reviewPath': args.review,
                'mediaPath': clip.get('path') or '',
                'collectionSectionId': result.get('collectionSectionId'),
                'collectionStatus': result.get('collectionStatus'),
                'collectionError': result.get('collectionError'),
            }
            state.setdefault('title_conflicts', {}).pop(str(clip['idx']), None)
            state.get('got_406', {}).pop(str(clip['idx']), None)
        elif result['status'] == 'title_conflict':
            title_conflicts.append(clip)
            record_title_conflict(
                state,
                clip,
                full_title,
                bvid=result.get('bvid') or '',
                online_title=result.get('onlineTitle') or full_title,
                reason='上传前发现同标题稿件，未确认线上媒体与本地媒体一致',
                review_path=args.review,
            )
        elif result['status'] in ('got_406', 'rate_limited'):
            state.setdefault('got_406', {})[str(clip['idx'])] = {
                'title': full_title,
                'needs_retry': True,
                'reason': result.get('error') or result['status'],
                'reviewPath': args.review,
                'mediaPath': clip.get('path') or '',
            }

        # 保存状态
        with open(state_path, 'w', encoding='utf-8') as f:
            json.dump(state, f, ensure_ascii=False, indent=2)

        if result['status'] == 'rate_limited':
            print("  [STOP] B站仍在限速，停止本批次，避免后续条目重复触发风控。")
            break

        # 间隔
        if i < len(to_upload) - 1:
            print(f"  等待 {args.delay}s...")
            await asyncio.sleep(args.delay)

    # === 第3步：汇总 ===
    print(f"\n=== 上传完成 ===")
    ok = sum(1 for r in results if r['status'] in ('ok', 'ok_after_406'))
    fail = sum(1 for r in results if r['status'] in ('fail', 'error'))
    conflicts = len(title_conflicts)
    got_406 = sum(1 for r in results if r['status'] == 'got_406')
    rate_limited = sum(1 for r in results if r['status'] == 'rate_limited')
    no_file = sum(1 for r in results if r['status'] == 'no_file')
    print(f"成功: {ok} | 同标题冲突: {conflicts} | 失败: {fail} | 待确认406: {got_406} | 限速停止: {rate_limited} | 文件缺失: {no_file}")
    print(f"状态文件: {state_path}")

    for r in sorted(results, key=lambda x: x['idx']):
        icon = {'ok': '✅', 'ok_after_406': '✅(406确认)', 'title_conflict': '⚠️(同标题冲突)', 'fail': '❌',
                'error': '❌', 'got_406': '❓', 'rate_limited': '⏸', 'no_file': '⚠️', 'no_cover': '⚠️'}.get(r['status'], '?')
        bvid = r.get('bvid', '')
        print(f"  {icon} [{r['idx']}] {r['title']} {bvid}")

    return 2 if title_conflicts else 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()) or 0)
