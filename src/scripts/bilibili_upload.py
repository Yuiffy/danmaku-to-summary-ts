#!/usr/bin/env python
"""
B站视频投稿脚本
用法: python bilili_upload.py <视频路径> --title "标题" --desc "简介" --tags "tag1,tag2,tag3" [--tid 分区] [--cover 封面路径]
"""
import sys
import os
import json
import asyncio
import argparse

# 添加项目路径
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(project_root, 'src', 'scripts'))

from config_loader import get_config, find_secrets_path
from bilibili_api import Credential, video_uploader, Picture

# 默认分区: 122 = 哔哩哔哩智能工作室，21 = 日常
DEFAULT_TID = 21

# 账号 mid
ACCOUNT_MID = 412141275  # 鹿饼Shikamochi

async def upload_video(
    video_path: str,
    title: str,
    desc: str,
    tags: list,
    tid: int = DEFAULT_TID,
    cover_path: str = None,
    dynamic: str = None,
    credential: Credential = None,
):
    """上传视频到B站"""
    
    if not os.path.exists(video_path):
        print(f"[ERROR] 视频文件不存在: {video_path}")
        return None
    
    file_size = os.path.getsize(video_path) / (1024 * 1024)
    print(f"[INFO] 视频文件: {video_path} ({file_size:.1f}MB)")
    print(f"[INFO] 标题: {title}")
    print(f"[INFO] 分区: {tid}")
    print(f"[INFO] 标签: {', '.join(tags)}")
    
    # 创建投稿页
    page = video_uploader.VideoUploaderPage(
        path=video_path,
        title=title,
        description=desc,
    )
    
    # 处理封面 - VideoMeta 要求 cover 不能为 None
    # 如果没有指定封面，从视频截取第一帧
    cover = None
    if cover_path and os.path.exists(cover_path):
        cover = Picture.from_file(cover_path)
        print(f"[INFO] 封面: {cover_path}")
    else:
        # 从视频截取第一帧作为封面
        import subprocess
        cover_tmp = os.path.join(os.path.dirname(video_path), '_tmp_cover.jpg')
        try:
            subprocess.run([
                'ffmpeg', '-i', video_path, '-vframes', '1',
                '-q:v', '2', cover_tmp, '-y', '-loglevel', 'error'
            ], check=True, timeout=30)
            cover = Picture.from_file(cover_tmp)
            print(f"[INFO] 封面: 从视频截取第一帧")
        except Exception as e:
            print(f"[WARN] 截取封面失败: {e}，使用纯色占位")
            # 创建一个最简单的 1x1 图片作为 fallback
            cover = Picture.from_file(cover_tmp) if os.path.exists(cover_tmp) else None
    
    if cover is None:
        print("[ERROR] 无法创建封面")
        return None
    
    # 创建元数据
    meta = video_uploader.VideoMeta(
        tid=tid,
        title=title,
        desc=desc,
        cover=cover,
        tags=tags,
        original=False,  # 转载/切片
        source="直播切片",  # 来源
    )
    
    # 创建上传器
    uploader = video_uploader.VideoUploader(
        pages=[page],
        meta=meta,
        credential=credential,
    )
    
    print("[INFO] 开始上传...")
    result = await uploader.start()
    
    if result:
        print(f"\n✅ 投稿成功!")
        if isinstance(result, dict):
            print(f"  bvid: {result.get('bvid', 'N/A')}")
            print(f"  aid: {result.get('aid', 'N/A')}")
            if result.get('bvid'):
                print(f"  链接: https://www.bilibili.com/video/{result['bvid']}")
        return result
    else:
        print("\n❌ 投稿失败")
        return None


def build_credential() -> Credential:
    """从配置构建凭证"""
    secrets_path = find_secrets_path()
    with open(secrets_path, 'r', encoding='utf-8-sig') as f:
        secrets = json.load(f)
    cookie_str = secrets.get('bilibili', {}).get('cookie', '')
    if not cookie_str:
        print("[ERROR] 未找到B站Cookie")
        sys.exit(1)
    
    # 解析cookie字符串
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


def main():
    parser = argparse.ArgumentParser(description='B站视频投稿')
    parser.add_argument('video', help='视频文件路径')
    parser.add_argument('--title', required=True, help='视频标题')
    parser.add_argument('--desc', default='', help='视频简介')
    parser.add_argument('--tags', default='虚拟主播,直播切片', help='标签(逗号分隔)')
    parser.add_argument('--tid', type=int, default=DEFAULT_TID, help='分区ID(默认21=日常)')
    parser.add_argument('--cover', default=None, help='封面图片路径')
    parser.add_argument('--dynamic', default=None, help='动态文案')
    parser.add_argument('--source-desc', default=None, help='来源描述，如：栞栞Shiori 直播《小栞来！》2026-06-06。会自动拼接到简介末尾。')
    
    args = parser.parse_args()
    
    tags = [t.strip() for t in args.tags.split(',') if t.strip()]
    
    credential = build_credential()
    print("[INFO] 凭证已创建")
    
    # 拼接来源信息到简介
    final_desc = args.desc
    if args.source_desc:
        final_desc = final_desc.rstrip() + '\n\n来源：' + args.source_desc

    result = asyncio.run(upload_video(
        video_path=args.video,
        title=args.title,
        desc=final_desc,
        tags=tags,
        tid=args.tid,
        cover_path=args.cover,
        dynamic=args.dynamic,
        credential=credential,
    ))
    
    if result:
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == '__main__':
    main()
