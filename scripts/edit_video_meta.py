"""
B站视频信息编辑工具
使用 bilibili_api.video_uploader.VideoEditor 修改已发布视频的标题、描述、标签等。

使用方法:
    from edit_video_meta import edit_video_meta, edit_videos_batch
    
    # 单个视频
    await edit_video_meta(credential, "BV1xxxx", title="新标题", tag="tag1,tag2", desc="新描述")
    
    # 批量
    await edit_videos_batch(credential, [
        ("BV1xxxx", {"title": "标题1", "tag": "tag1,tag2"}),
        ("BV2xxxx", {"title": "标题2", "tag": "tag1,tag2"}),
    ])
    
    # 命令行
    python edit_video_meta.py --bvid BV1xxxx --title "新标题" --tag "tag1,tag2"

注意事项:
    - VideoEditor 需要 credential 包含 sessdata, bili_jct, dedeuserid, ac_time_value
    - ac_time_value 可从 cookie 中获取，没有的话用空字符串
    - B站有编辑频率限制，建议每次编辑间隔 3 秒以上
    - 不需要设置事件监听器，直接 await editor.start() 即可
    - meta 中的必要字段参考下方 Meta 数据结构

API 踩坑记录:
    - 直接用 requests 调 member.bilibili.com/x/vu/web/edit 会遇到 csrf 校验失败
    - 用 form data 还是 JSON 都不行，因为 B站内部有额外的签名机制
    - VideoEditor 封装了这些细节，是唯一可靠的方式
    - VideoEditor 来自 bilibili_api.video_uploader 模块（不是 video 模块）
    - 需要安装: pip install bilibili-api-python

Meta 数据结构（可修改的字段）:
    {
        "title": str,           # 视频标题
        "copyright": int,       # 1=自制, 2=转载
        "tag": str,             # 逗号分隔的标签
        "desc_format_id": int,  # 描述格式, 9999=纯文本
        "desc": str,            # 视频描述
        "dynamic": str,         # 动态文案
        "interactive": int,     # 互动视频标记
        "new_web_edit": int,    # 固定 1
        "act_reserve_create": int,  # 固定 0
        "handle_staff": bool,   # 固定 False
        "topic_grey": int,      # 固定 1
        "no_reprint": int,      # 0=允许转载, 1=禁止
        "subtitles": {"lan": "", "open": 0},
        "web_os": int,          # 固定 2
    }
    不需要包含 cover、source、tid、videos 等字段，VideoEditor 会从现有视频信息中自动补全。

历史:
    - 2026-06-09: 首次创建，基于岁己切片标题批量修改的经验
"""

import asyncio
import argparse
import json
import re
import sys
from typing import Optional

from bilibili_api import Credential
from bilibili_api.video_uploader import VideoEditor


def build_credential_from_secret(secret_path: str = None) -> Credential:
    """从 danmaku-to-summary-ts 的 secret.json 构建 Credential"""
    if secret_path is None:
        # 尝试默认路径
        import os
        candidates = [
            r"D:\workspace\myrepo\danmaku-to-summary-ts\config\secret.json",
        ]
        for p in candidates:
            if os.path.exists(p):
                secret_path = p
                break
    
    if secret_path is None:
        raise FileNotFoundError("找不到 secret.json，请手动指定路径")
    
    with open(secret_path, 'r', encoding='utf-8-sig') as f:
        secret = json.load(f)
    
    cookie_str = secret.get('bilibili', {}).get('cookie', '')
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
        dedeuserid=cookies.get('DedeUserID', ''),
        ac_time_value=cookies.get('ac_time_value', ''),
    )


async def edit_video_meta(
    credential: Credential,
    bvid: str,
    title: Optional[str] = None,
    tag: Optional[str] = None,
    desc: Optional[str] = None,
    dynamic: Optional[str] = None,
    no_reprint: int = 0,
    copyright: int = None,
    extra_meta: dict = None,
) -> dict:
    """
    编辑单个视频的元数据。
    
    Args:
        credential: B站登录凭证
        bvid: 视频BV号
        title: 新标题（None 表示不修改，但 VideoEditor 会保留原值）
        tag: 新标签（逗号分隔）
        desc: 新描述
        dynamic: 新动态文案
        no_reprint: 是否禁止转载
        copyright: 版权类型 1=自制 2=转载
        extra_meta: 额外的 meta 字段（会覆盖上述字段）
    
    Returns:
        编辑结果
    """
    meta = {
        "interactive": 0,
        "new_web_edit": 1,
        "act_reserve_create": 0,
        "handle_staff": False,
        "topic_grey": 1,
        "no_reprint": no_reprint,
        "subtitles": {"lan": "", "open": 0},
        "web_os": 2,
        "desc_format_id": 9999,
        "dynamic": dynamic or "",
    }
    
    if title is not None:
        meta["title"] = title
    if tag is not None:
        meta["tag"] = tag
    if desc is not None:
        meta["desc"] = desc
    if copyright is not None:
        meta["copyright"] = copyright
    
    if extra_meta:
        meta.update(extra_meta)
    
    editor = VideoEditor(
        bvid=bvid,
        meta=meta,
        credential=credential,
    )
    
    result = await editor.start()
    return result


async def edit_videos_batch(
    credential: Credential,
    updates: list[tuple[str, dict]],
    interval: float = 3.0,
) -> list[tuple[str, bool, str]]:
    """
    批量编辑视频元数据。
    
    Args:
        credential: B站登录凭证
        updates: [(bvid, {title, tag, desc, ...}), ...]
        interval: 每次编辑之间的间隔秒数（避免触发频率限制）
    
    Returns:
        [(bvid, success, message), ...]
    """
    results = []
    
    for i, (bvid, kwargs) in enumerate(updates):
        try:
            await edit_video_meta(credential, bvid, **kwargs)
            results.append((bvid, True, "OK"))
            print(f"✅ [{i+1}/{len(updates)}] {bvid}: {kwargs.get('title', 'updated')}")
        except Exception as e:
            results.append((bvid, False, str(e)))
            print(f"❌ [{i+1}/{len(updates)}] {bvid}: {e}")
        
        if i < len(updates) - 1:
            await asyncio.sleep(interval)
    
    return results


def main():
    parser = argparse.ArgumentParser(description="B站视频信息编辑工具")
    parser.add_argument("--bvid", required=True, help="视频BV号")
    parser.add_argument("--title", help="新标题")
    parser.add_argument("--tag", help="新标签（逗号分隔）")
    parser.add_argument("--desc", help="新描述")
    parser.add_argument("--secret", help="secret.json 路径（可选）")
    
    args = parser.parse_args()
    
    sys.stdout.reconfigure(encoding='utf-8')
    credential = build_credential_from_secret(args.secret)
    
    kwargs = {}
    if args.title:
        kwargs["title"] = args.title
    if args.tag:
        kwargs["tag"] = args.tag
    if args.desc:
        kwargs["desc"] = args.desc
    
    result = asyncio.run(edit_video_meta(credential, args.bvid, **kwargs))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
