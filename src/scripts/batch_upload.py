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
  --dry-run    只查重不实际上传
  --state      状态文件路径（默认：同目录下 upload_state.json）

核心防重复逻辑:
  1. 上传前：通过搜索 API 查同名稿件是否已存在
  2. 上传后：等待确认 BV 号
  3. 406 错误：不盲目重试，先查搜索确认是否已上传成功
  4. 状态持久化：记录每次上传结果到 state 文件
"""

import sys
import os
import json
import asyncio
import argparse
import re
import time
import datetime

# 添加项目路径
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(PROJECT_ROOT, 'src', 'scripts'))

from config_loader import get_config, find_secrets_path
from bilibili_api import Credential, video_uploader, Picture, video
import requests

ACCOUNT_MID = 412141275


def build_credential():
    secrets_path = find_secrets_path()
    with open(secrets_path, 'r', encoding='utf-8-sig') as f:
        secrets = json.load(f)
    cookie_str = secrets.get('bilibili', {}).get('cookie', '')
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


def parse_review(review_path):
    """解析 REVIEW.md，提取切片列表。
    预期格式: 序号. 标题 | 开始时间 | 时长 | 文件路径
    """
    clips = []
    with open(review_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            # 匹配 "1. 标题 | 00:44:48 | 00:04:19 | 路径"
            m = re.match(r'^(\d+)\.\s*(.+?)\s*\|\s*(\d{2}:\d{2}:\d{2})\s*\|\s*(\d{2}:\d{2}:\d{2})\s*\|?\s*(.+)?$', line)
            if m:
                idx = int(m.group(1))
                title = m.group(2).strip()
                start = m.group(3).strip()
                dur = m.group(4).strip()
                path = m.group(5).strip() if m.group(5) else ''
                clips.append({
                    'idx': idx,
                    'title': title,
                    'start': start,
                    'duration': dur,
                    'path': path,
                })
    return clips


def build_desc(clip_title, source_desc, start_str, dur_str):
    """构建视频简介"""
    parts = dur_str.split(':')
    dur_sec = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    sparts = start_str.split(':')
    start_sec = int(sparts[0]) * 3600 + int(sparts[1]) * 60 + int(sparts[2])
    end_sec = start_sec + dur_sec
    def s2str(s):
        h = s // 3600; m = (s % 3600) // 60; s = s % 60
        return f'{h:02d}:{m:02d}:{s:02d}'
    start_min = start_sec // 60
    return (
        f"直播切片\n{clip_title}\n\n"
        f"来源：{source_desc}\n"
        f"切片时间：{start_str} - {s2str(end_sec)}"
        f"（直播开始后第{start_min}分钟）\n\n"
        f"来源：{source_desc}"
    )


async def upload_one(clip, credential, prefix, tags, tid, source_desc):
    """上传单个切片，返回结果 dict"""
    full_title = f"{prefix}{clip['title']}"
    filepath = clip['path']

    if not filepath or not os.path.exists(filepath):
        print(f"  [SKIP] 文件不存在: {filepath}")
        return {'idx': clip['idx'], 'title': full_title, 'status': 'no_file'}

    desc = build_desc(clip['title'], source_desc, clip['start'], clip['duration'])
    size_mb = os.path.getsize(filepath) / (1024 * 1024)
    print(f"  文件: {os.path.basename(filepath)} ({size_mb:.1f}MB)")

    # 截取封面
    cover_tmp = os.path.join(os.path.dirname(filepath), f'_tmp_cover_{clip["idx"]}.jpg')
    try:
        import subprocess
        subprocess.run([
            'ffmpeg', '-i', filepath, '-vframes', '1',
            '-q:v', '2', cover_tmp, '-y', '-loglevel', 'error'
        ], check=True, timeout=30)
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
            try: os.remove(cover_tmp)
            except: pass
            return {'idx': clip['idx'], 'title': full_title, 'status': 'ok', 'bvid': bvid}
        else:
            print(f"  ❌ 上传返回无效结果: {result}")
            try: os.remove(cover_tmp)
            except: pass
            return {'idx': clip['idx'], 'title': full_title, 'status': 'fail'}
    except Exception as e:
        err = str(e)
        try: os.remove(cover_tmp)
        except: pass
        if '406' in err:
            print(f"  ❌ 406 错误（可能已上传成功，需查搜索确认）")
            return {'idx': clip['idx'], 'title': full_title, 'status': 'got_406'}
        else:
            print(f"  ❌ 错误: {err[:200]}")
            return {'idx': clip['idx'], 'title': full_title, 'status': 'error', 'error': err[:200]}


async def main():
    parser = argparse.ArgumentParser(description='B站批量切片投稿（防重复版）')
    parser.add_argument('--review', required=True, help='REVIEW.md 路径')
    parser.add_argument('--source', required=True, help='来源描述')
    parser.add_argument('--tags', default='小岁,虚拟主播,直播切片,岁AI切片', help='标签')
    parser.add_argument('--prefix', default='【小岁】', help='标题前缀')
    parser.add_argument('--tid', type=int, default=21, help='分区ID')
    parser.add_argument('--delay', type=int, default=30, help='上传间隔秒数')
    parser.add_argument('--skip', default='', help='跳过序号（逗号分隔）')
    parser.add_argument('--only', default='', help='只传指定序号（逗号分隔）')
    parser.add_argument('--dry-run', action='store_true', help='只查重不上传')
    parser.add_argument('--state', default=None, help='状态文件路径')
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

    # === 第1步：查重 ===
    print(f"\n=== 第1步：搜索查重 ===")
    search_keyword = args.prefix.strip('【】')
    existing = search_existing_titles(cookie_str, search_keyword)
    print(f"[INFO] 搜索到本账号 {len(existing)} 个已上传视频")

    # 过滤要上传的切片
    to_upload = []
    skipped_dup = []
    skipped_state = []
    skipped_arg = []
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
        if str(clip['idx']) in state.get('done', {}):
            skipped_state.append(clip)
            continue

        # 搜索查重
        if full_title in existing:
            bvid = existing[full_title]
            print(f"  [{clip['idx']}] SKIP (搜索已存在): {full_title} -> {bvid}")
            skipped_dup.append(clip)
            state.setdefault('done', {})[str(clip['idx'])] = {
                'title': full_title, 'bvid': bvid, 'source': 'search_dup'
            }
            continue

        to_upload.append(clip)

    print(f"\n[INFO] 跳过(已传): {len(skipped_dup)} | 跳过(参数): {len(skipped_arg)} | 待上传: {len(to_upload)}")

    # 保存查重结果到状态
    with open(state_path, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

    if args.dry_run:
        print("\n[DRY-RUN] 不实际上传。")
        for clip in to_upload:
            print(f"  [{clip['idx']}] {args.prefix}{clip['title']}")
        return

    if not to_upload:
        print("\n[INFO] 没有需要上传的切片。")
        return

    # === 第2步：上传 ===
    print(f"\n=== 第2步：开始上传（间隔 {args.delay}s）===")
    credential = build_credential()
    print("[INFO] 凭证已创建\n")

    results = []
    for i, clip in enumerate(to_upload):
        full_title = f"{args.prefix}{clip['title']}"
        print(f"[{i+1}/{len(to_upload)}] #{clip['idx']} {full_title}")

        result = await upload_one(clip, credential, args.prefix, tags, args.tid, args.source)
        results.append(result)

        # 记录到状态
        if result['status'] == 'ok':
            state.setdefault('done', {})[str(clip['idx'])] = {
                'title': full_title, 'bvid': result['bvid'], 'source': 'upload'
            }

        # === 406 特殊处理：不盲目重试，查搜索确认 ===
        if result['status'] == 'got_406':
            print(f"  [406处理] 等待 15 秒后查搜索确认...")
            await asyncio.sleep(15)
            # 重新搜索
            re_search = search_existing_titles(cookie_str, full_title[:10])
            if full_title in re_search:
                bvid = re_search[full_title]
                print(f"  ✅ 406 实际已上传成功: {bvid}")
                result['status'] = 'ok_after_406'
                result['bvid'] = bvid
                state.setdefault('done', {})[str(clip['idx'])] = {
                    'title': full_title, 'bvid': bvid, 'source': '406_confirmed'
                }
            else:
                print(f"  ❓ 406 后搜索未找到，可能确实失败，稍后可重试")
                state.setdefault('got_406', {})[str(clip['idx'])] = {
                    'title': full_title, 'needs_retry': True
                }

        # 保存状态
        with open(state_path, 'w', encoding='utf-8') as f:
            json.dump(state, f, ensure_ascii=False, indent=2)

        # 间隔
        if i < len(to_upload) - 1:
            print(f"  等待 {args.delay}s...")
            await asyncio.sleep(args.delay)

    # === 第3步：汇总 ===
    print(f"\n=== 上传完成 ===")
    ok = sum(1 for r in results if r['status'] in ('ok', 'ok_after_406'))
    fail = sum(1 for r in results if r['status'] in ('fail', 'error'))
    got_406 = sum(1 for r in results if r['status'] == 'got_406')
    no_file = sum(1 for r in results if r['status'] == 'no_file')
    print(f"成功: {ok} | 失败: {fail} | 待确认406: {got_406} | 文件缺失: {no_file}")
    print(f"状态文件: {state_path}")

    for r in sorted(results, key=lambda x: x['idx']):
        icon = {'ok': '✅', 'ok_after_406': '✅(406确认)', 'fail': '❌',
                'error': '❌', 'got_406': '❓', 'no_file': '⚠️', 'no_cover': '⚠️'}.get(r['status'], '?')
        bvid = r.get('bvid', '')
        print(f"  {icon} [{r['idx']}] {r['title']} {bvid}")


if __name__ == '__main__':
    asyncio.run(main())
