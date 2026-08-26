#!/usr/bin/env python
"""
B站视频上传脚本。

用法:
  python bilibili_upload.py <视频路径> --title "标题" --desc "简介" --tags "tag1,tag2,tag3" [--tid 分区] [--cover 封面路径]
"""

import argparse
import asyncio
import json
import os
import re
import sys
import time
from typing import Optional

project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(project_root, 'src', 'scripts'))

from config_loader import get_config, find_secrets_path
from bilibili_api import Credential, Picture, video_uploader
import requests

DEFAULT_TID = 21
ACCOUNT_MID = 412141275


def build_credential() -> Credential:
    """从 config/secret.json 构造 B 站凭证。"""
    secrets_path = find_secrets_path()
    with open(secrets_path, 'r', encoding='utf-8-sig') as f:
        secrets = json.load(f)

    cookie_str = secrets.get('bilibili', {}).get('cookie', '')
    if not cookie_str:
        print('[ERROR] 未找到 B 站 cookie')
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


def _positive_collection_id(value) -> Optional[int]:
    if value in (None, '', 0):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _routing_entry(upload_cfg: dict, key: str) -> dict:
    routing = upload_cfg.get('collectionRouting') or {}
    entry = routing.get(key) if isinstance(routing, dict) else None
    return entry if isinstance(entry, dict) else {}


def _is_sui_context(
    *,
    upload_cfg: dict,
    streamer_name: Optional[str] = None,
    room_id: Optional[str] = None,
    source_desc: Optional[str] = None,
    title: Optional[str] = None,
    prefix: Optional[str] = None,
) -> bool:
    """Classify the source streamer without treating a topic mention as ownership."""
    sui_entry = _routing_entry(upload_cfg, 'sui')
    room_ids = sui_entry.get('roomIds') or ['25788785']
    if str(room_id or '').strip() in {str(value).strip() for value in room_ids}:
        return True

    identity = str(streamer_name or prefix or '').strip()
    if not identity:
        title_text = str(title or '').strip()
        match = re.match(r'^\s*【([^】]+)】', title_text)
        identity = match.group(1).strip() if match else ''
    if identity:
        markers = sui_entry.get('markers') or ['岁己', '小岁', 'sui']
        return any(str(marker).casefold() in identity.casefold() for marker in markers)

    # A source description normally starts with the streamer name.  Only use
    # that leading identity as a fallback, so "小栞提及岁己" stays non-Sui.
    source_text = str(source_desc or '').strip()
    leading = re.split(r'\s+直播|[《(（]', source_text, maxsplit=1)[0].strip()
    if not leading:
        return False
    markers = sui_entry.get('markers') or ['岁己', '小岁', 'sui']
    return any(str(marker).casefold() in leading.casefold() for marker in markers)


def get_collection_section_id(
    config: Optional[dict] = None,
    *,
    streamer_name: Optional[str] = None,
    room_id: Optional[str] = None,
    source_desc: Optional[str] = None,
    title: Optional[str] = None,
    prefix: Optional[str] = None,
) -> Optional[int]:
    """Resolve the upload collection section for a streamer.

    ``8513688`` and ``8941979`` are season IDs shown by Bilibili.  The upload
    endpoint needs their child section IDs, configured as ``sectionId`` below.
    The legacy single ``collectionSectionId`` remains the default fallback.
    """
    config = config or get_config()
    upload_cfg = (config.get('bilibili') or {}).get('upload') or {}
    sui_entry = _routing_entry(upload_cfg, 'sui')
    other_entry = _routing_entry(upload_cfg, 'other') or _routing_entry(upload_cfg, 'default')

    if _is_sui_context(
        upload_cfg=upload_cfg,
        streamer_name=streamer_name,
        room_id=room_id,
        source_desc=source_desc,
        title=title,
        prefix=prefix,
    ):
        section_id = _positive_collection_id(sui_entry.get('sectionId'))
    else:
        section_id = _positive_collection_id(other_entry.get('sectionId'))

    if section_id is None:
        section_id = _positive_collection_id(upload_cfg.get('collectionSectionId'))
    if section_id is None:
        section_id = _positive_collection_id(upload_cfg.get('collectionSeriesId'))
    if section_id is None:
        configured = sui_entry.get('sectionId') if _is_sui_context(
            upload_cfg=upload_cfg,
            streamer_name=streamer_name,
            room_id=room_id,
            source_desc=source_desc,
            title=title,
            prefix=prefix,
        ) else other_entry.get('sectionId')
        if configured not in (None, ''):
            print(f'[WARN] 无效的合集 section_id: {configured}')
    return section_id


# 向后兼容别名
get_collection_series_id = get_collection_section_id


def _build_cookie_str(credential: Credential) -> str:
    """从 Credential 对象拼出 cookie 字符串。"""
    parts = []
    if getattr(credential, 'sessdata', ''):
        parts.append(f'SESSDATA={credential.sessdata}')
    if getattr(credential, 'bili_jct', ''):
        parts.append(f'bili_jct={credential.bili_jct}')
    if getattr(credential, 'buvid3', ''):
        parts.append(f'buvid3={credential.buvid3}')
    if getattr(credential, 'dedeuserid', ''):
        parts.append(f'DedeUserID={credential.dedeuserid}')
    return '; '.join(parts)


def add_episode_to_section(
    section_id: int,
    aid: int,
    cid: int,
    title: str,
    credential: Credential,
) -> dict:
    """通过创作中心接口把视频作为 episode 加入合集 section。

    接口: POST /x2/creative/web/season/section/episodes/add
    """
    csrf = getattr(credential, 'bili_jct', '')
    url = 'https://member.bilibili.com/x2/creative/web/season/section/episodes/add'
    params = {'t': str(int(time.time() * 1000)), 'csrf': csrf}
    payload = {
        'sectionId': int(section_id),
        'episodes': [{'title': title, 'cid': int(cid), 'aid': int(aid)}],
    }
    headers = {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'origin': 'https://member.bilibili.com',
        'referer': 'https://member.bilibili.com/platform/upload/video/frame?type=edit',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0',
        'cookie': _build_cookie_str(credential),
    }
    resp = requests.post(url, params=params, json=payload, headers=headers, timeout=20)
    return resp.json()


async def attach_video_to_collection(
    upload_result,
    credential: Credential,
    collection_section_id: Optional[int] = None,
    config: Optional[dict] = None,
    streamer_name: Optional[str] = None,
    room_id: Optional[str] = None,
    source_desc: Optional[str] = None,
    prefix: Optional[str] = None,
):
    """把已上传的视频加入合集（创作中心 episodes/add 接口）。"""
    if not isinstance(upload_result, dict):
        return None

    section_id = collection_section_id if collection_section_id is not None else get_collection_section_id(
        config,
        streamer_name=streamer_name,
        room_id=room_id,
        source_desc=source_desc,
        title=(upload_result or {}).get('title') if isinstance(upload_result, dict) else None,
        prefix=prefix,
    )
    if not section_id:
        return None

    aid = upload_result.get('aid')
    cid = upload_result.get('cid')
    bvid = upload_result.get('bvid')
    title = upload_result.get('title') or upload_result.get('video_title') or ''

    # 如果缺少 aid 或 cid，用 bvid 查 view API 补全
    if (aid in (None, '') or cid in (None, '')) and bvid:
        try:
            print(f'[INFO] 补全 aid/cid: 查询 {bvid} ...')
            view_url = f'https://api.bilibili.com/x/web-interface/view?bvid={bvid}'
            cookie_str = _build_cookie_str(credential)
            view_headers = {
                'accept': 'application/json, text/plain, */*',
                'cookie': cookie_str,
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0',
            }
            view_resp = requests.get(view_url, headers=view_headers, timeout=15)
            view_data = view_resp.json()
            if view_data.get('code') == 0:
                info = view_data['data']
                if aid in (None, ''):
                    aid = info.get('aid')
                    upload_result['aid'] = aid
                if cid in (None, ''):
                    cid = info.get('cid')
                    upload_result['cid'] = cid
                if not title:
                    title = info.get('title', '')
                print(f'[INFO] 补全成功: aid={aid}, cid={cid}')
            else:
                print(f'[WARN] 查询失败: {view_data}')
        except Exception as e:
            print(f'[WARN] 补全 aid/cid 异常: {e}')

    if aid in (None, ''):
        print(f'[WARN] 已上传但没有 aid，跳过合集关联 section_id={section_id}')
        upload_result['collectionSectionId'] = int(section_id)
        upload_result['collectionStatus'] = 'skipped_no_aid'
        return None

    if cid in (None, ''):
        print(f'[WARN] 已上传但没有 cid，跳过合集关联 section_id={section_id}')
        upload_result['collectionSectionId'] = int(section_id)
        upload_result['collectionStatus'] = 'skipped_no_cid'
        return None

    try:
        data = add_episode_to_section(int(section_id), int(aid), int(cid), title, credential)
        if data.get('code') == 0:
            upload_result['collectionSectionId'] = int(section_id)
            upload_result['collectionStatus'] = 'ok'
            print(f'[INFO] 已加入合集 section_id={section_id}, aid={aid}, cid={cid}')
        else:
            upload_result['collectionSectionId'] = int(section_id)
            upload_result['collectionStatus'] = 'failed'
            upload_result['collectionError'] = f"code={data.get('code')}, message={data.get('message', '')}"
            upload_result['collectionApiResponse'] = data
            print(f'[WARN] 加入合集失败 section_id={section_id}: code={data.get("code")}, message={data.get("message", "")}')
    except Exception as e:
        upload_result['collectionSectionId'] = int(section_id)
        upload_result['collectionStatus'] = 'failed'
        upload_result['collectionError'] = str(e)[:200]
        print(f'[WARN] 加入合集异常 section_id={section_id}, aid={aid}: {e}')

    return upload_result


async def upload_video(
    video_path: str,
    title: str,
    desc: str,
    tags: list,
    tid: int = DEFAULT_TID,
    cover_path: str = None,
    dynamic: str = None,
    credential: Credential = None,
    collection_section_id: Optional[int] = None,
    source_desc: Optional[str] = None,
    streamer_name: Optional[str] = None,
    room_id: Optional[str] = None,
):
    """上传视频到 B 站。"""
    if not os.path.exists(video_path):
        print(f'[ERROR] 视频文件不存在: {video_path}')
        return None

    file_size = os.path.getsize(video_path) / (1024 * 1024)
    print(f'[INFO] 视频文件: {video_path} ({file_size:.1f}MB)')
    print(f'[INFO] 标题: {title}')
    print(f'[INFO] 分区: {tid}')
    print(f"[INFO] 标签: {', '.join(tags)}")

    page = video_uploader.VideoUploaderPage(
        path=video_path,
        title=title,
        description=desc,
    )

    cover = None
    tmp_cover = os.path.join(os.path.dirname(video_path), '_tmp_cover.jpg')
    try:
        if cover_path and os.path.exists(cover_path):
            cover = Picture.from_file(cover_path)
            print(f'[INFO] 封面: {cover_path}')
        else:
            import subprocess

            subprocess.run(
                [
                    'ffmpeg',
                    '-i',
                    video_path,
                    '-vframes',
                    '1',
                    '-q:v',
                    '2',
                    tmp_cover,
                    '-y',
                    '-loglevel',
                    'error',
                ],
                check=True,
                timeout=30,
            )
            cover = Picture.from_file(tmp_cover)
            print('[INFO] 封面: 从视频截取第一帧')
    except Exception as e:
        print(f'[WARN] 截取封面失败: {e}')
        if os.path.exists(tmp_cover):
            try:
                cover = Picture.from_file(tmp_cover)
            except Exception:
                cover = None

    if cover is None:
        print('[ERROR] 无法创建封面')
        return None

    meta = video_uploader.VideoMeta(
        tid=tid,
        title=title,
        desc=desc,
        cover=cover,
        tags=tags,
        original=False,
        source='直播切片',
        dynamic=dynamic,
    )

    uploader = video_uploader.VideoUploader(
        pages=[page],
        meta=meta,
        credential=credential,
    )

    print('[INFO] 开始上传...')
    result = await uploader.start()
    if result:
        if collection_section_id is None:
            collection_section_id = get_collection_section_id(
                streamer_name=streamer_name,
                room_id=room_id,
                source_desc=source_desc,
                title=title,
            )
        await attach_video_to_collection(
            result,
            credential,
            collection_section_id=collection_section_id,
        )
        print('\n✅ 投稿成功!')
        if isinstance(result, dict):
            print(f"  bvid: {result.get('bvid', 'N/A')}")
            print(f"  aid: {result.get('aid', 'N/A')}")
            if result.get('collectionSectionId'):
                print(
                    f"  合集: {result.get('collectionSectionId')} "
                    f"({result.get('collectionStatus', 'unknown')})"
                )
            if result.get('bvid'):
                print(f"  链接: https://www.bilibili.com/video/{result['bvid']}")
        return result

    print('\n❌ 投稿失败')
    return None


def main():
    parser = argparse.ArgumentParser(description='B站视频投稿')
    parser.add_argument('video', help='视频文件路径')
    parser.add_argument('--title', required=True, help='视频标题')
    parser.add_argument('--desc', default='', help='视频简介')
    parser.add_argument('--tags', default='虚拟主播,直播切片', help='标签(逗号分隔)')
    parser.add_argument('--tid', type=int, default=DEFAULT_TID, help='分区ID(默认21=日常)')
    parser.add_argument('--cover', default=None, help='封面图片路径')
    parser.add_argument('--dynamic', default=None, help='动态文案')
    parser.add_argument('--source-desc', default=None, help='来源描述，会自动拼到简介末尾')
    parser.add_argument('--collection-series-id', type=int, default=None, help='投稿后自动加入的合集 section_id（兼容旧参数名）')

    args = parser.parse_args()
    tags = [t.strip() for t in args.tags.split(',') if t.strip()]
    credential = build_credential()
    print('[INFO] 凭证已创建')

    final_desc = args.desc
    if args.source_desc:
        final_desc = final_desc.rstrip() + '\n\n来源：' + args.source_desc

    collection_section_id = args.collection_series_id
    if collection_section_id is None:
        collection_section_id = get_collection_section_id(
            source_desc=args.source_desc,
            title=args.title,
        )

    result = asyncio.run(
        upload_video(
            video_path=args.video,
            title=args.title,
            desc=final_desc,
            tags=tags,
            tid=args.tid,
            cover_path=args.cover,
            dynamic=args.dynamic,
            credential=credential,
            collection_section_id=collection_section_id,
            source_desc=args.source_desc,
        )
    )

    sys.exit(0 if result else 1)


if __name__ == '__main__':
    main()
