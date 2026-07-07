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


def get_collection_section_id(config: Optional[dict] = None) -> Optional[int]:
    """从配置中读取要自动加入的合集 section_id。

    优先读 collectionSectionId；如果没有则回退到旧的 collectionSeriesId。
    """
    config = config or get_config()
    upload_cfg = (config.get('bilibili') or {}).get('upload') or {}
    section_id = upload_cfg.get('collectionSectionId') or upload_cfg.get('collectionSeriesId')
    if section_id in (None, '', 0):
        return None
    try:
        return int(section_id)
    except (TypeError, ValueError):
        print(f'[WARN] 无效的合集 section_id: {section_id}')
        return None


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
):
    """把已上传的视频加入合集（创作中心 episodes/add 接口）。"""
    if not isinstance(upload_result, dict):
        return None

    section_id = collection_section_id if collection_section_id is not None else get_collection_section_id(config)
    if not section_id:
        return None

    aid = upload_result.get('aid')
    cid = upload_result.get('cid')
    title = upload_result.get('title') or upload_result.get('video_title') or ''

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
    parser.add_argument('--collection-series-id', type=int, default=None, help='投稿后自动加入的合集 series_id')

    args = parser.parse_args()
    tags = [t.strip() for t in args.tags.split(',') if t.strip()]
    credential = build_credential()
    print('[INFO] 凭证已创建')

    final_desc = args.desc
    if args.source_desc:
        final_desc = final_desc.rstrip() + '\n\n来源：' + args.source_desc

    collection_section_id = args.collection_series_id
    if collection_section_id is None:
        collection_section_id = get_collection_section_id()

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
        )
    )

    sys.exit(0 if result else 1)


if __name__ == '__main__':
    main()
