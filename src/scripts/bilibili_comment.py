#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B站评论发布脚本
使用 bilibili-api-python 库处理B站评论功能
"""

import sys
import json
import asyncio
import io
import aiohttp
from bilibili_api import comment, Credential
from bilibili_api.comment import CommentResourceType

# 禁用输出缓冲，确保日志实时输出到Node.js
try:
    if hasattr(sys.stdout, 'buffer') and not sys.stdout.closed:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
    if hasattr(sys.stderr, 'buffer') and not sys.stderr.closed:
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', line_buffering=True)
except (ValueError, AttributeError, OSError):
    pass

# 创建安全的打印函数
def safe_print(*args, **kwargs):
    """安全的打印函数，在stdout/stderr不可用时静默失败"""
    try:
        __builtins__.print(*args, **kwargs)
    except (ValueError, OSError, AttributeError):
        pass

# 日志输出到stderr，JSON结果输出到stdout
def log(*args, **kwargs):
    """日志输出到stderr"""
    try:
        __builtins__.print(*args, file=sys.stderr, **kwargs)
    except (ValueError, OSError, AttributeError):
        pass

print = safe_print


async def get_dynamic_comment_id(dynamic_id: str) -> tuple[str, CommentResourceType]:
    """
    获取动态的comment_id和评论类型

    Args:
        dynamic_id: 动态ID

    Returns:
        tuple: (comment_id, comment_type)
    """
    url = f"https://api.bilibili.com/x/polymer/web-dynamic/v1/detail"
    params = {
        'id': dynamic_id,
        'timezone_offset': '-480',
        'features': 'itemOpusStyle'
    }
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com/'
    }

    async with aiohttp.ClientSession() as session:
        async with session.get(url, params=params, headers=headers) as response:
            data = await response.json()

            if data.get('code') != 0:
                raise Exception(f"获取动态详情失败: {data.get('message')}")

            item = data.get('data', {}).get('item', {})
            basic = item.get('basic', {})
            comment_id_str = basic.get('comment_id_str', '')
            comment_type = basic.get('comment_type', 11)

            # 根据comment_type映射到CommentResourceType
            if comment_type == 11:
                comment_resource_type = CommentResourceType.DYNAMIC_DRAW
            elif comment_type == 17:
                comment_resource_type = CommentResourceType.DYNAMIC
            elif comment_type == 12:
                comment_resource_type = CommentResourceType.ARTICLE
            else:
                comment_resource_type = CommentResourceType.DYNAMIC_DRAW

            return comment_id_str, comment_resource_type


async def publish_comment(dynamic_id: str, content: str, sessdata: str, bili_jct: str, dedeuserid: str) -> dict:
    """
    发布动态评论

    Args:
        dynamic_id: 动态ID
        content: 评论内容
        sessdata: SESSDATA
        bili_jct: CSRF Token
        dedeuserid: DedeUserID

    Returns:
        dict: 包含评论结果的字典
    """
    log(f"[INFO] 开始发布评论到动态: {dynamic_id}")
    log(f"[INFO] 评论内容: {content}")

    try:
        # 获取动态的comment_id和评论类型
        log(f"[INFO] 获取动态的comment_id...")
        comment_id, comment_type = await get_dynamic_comment_id(dynamic_id)
        log(f"[INFO] 获取到comment_id: {comment_id}, 评论类型: {comment_type.value}")

        # 创建 Credential 对象
        log(f"[INFO] 创建凭证对象...")
        credential = Credential(
            sessdata=sessdata,
            bili_jct=bili_jct,
            dedeuserid=dedeuserid
        )

        # 验证凭证是否有效
        log(f"[INFO] 验证凭证有效性...")
        is_valid = await credential.check_valid()
        log(f"[INFO] 凭证验证结果: {'有效' if is_valid else '无效'}")

        if not is_valid:
            log(f"[ERROR] 凭证无效，SESSDATA或bili_jct无效，请检查Cookie")
            return {
                'success': False,
                'error': '凭证无效',
                'message': 'SESSDATA或bili_jct无效，请检查Cookie'
            }

        # 使用 comment.send_comment 函数发送评论
        log(f"[INFO] 调用B站API发送评论，oid={comment_id}, type={comment_type.value}...")
        result = await comment.send_comment(
            text=content,
            oid=int(comment_id),
            type_=comment_type,
            credential=credential
        )

        reply_id = str(result.get('rpid', ''))
        log(f"[OK] 评论发布成功，回复ID: {reply_id}")
        
        return {
            'success': True,
            'reply_id': reply_id,
            'message': '评论发布成功'
        }

    except Exception as e:
        log(f"[ERROR] 评论发布失败: {e}")
        import traceback
        traceback.print_exc()
        return {
            'success': False,
            'error': str(e),
            'message': '评论发布失败'
        }


def main():
    """主函数"""
    log(f"[INFO] B站评论发布脚本启动")
    
    # 从命令行参数读取输入
    if len(sys.argv) < 6:
        log(f"[ERROR] 参数不足，需要参数: dynamic_id content sessdata bili_jct dedeuserid")
        print(json.dumps({
            'success': False,
            'error': '参数不足',
            'message': '需要参数: dynamic_id content sessdata bili_jct dedeuserid'
        }))
        sys.exit(1)

    dynamic_id = sys.argv[1]
    content = sys.argv[2]
    sessdata = sys.argv[3]
    bili_jct = sys.argv[4]
    dedeuserid = sys.argv[5]

    log(f"[INFO] 接收到参数: dynamic_id={dynamic_id}, content_length={len(content)}")

    # 发布评论
    result = asyncio.run(publish_comment(dynamic_id, content, sessdata, bili_jct, dedeuserid))

    # 输出JSON结果到stdout（仅JSON，不带日志前缀）
    log(f"[INFO] 输出结果: {json.dumps(result, ensure_ascii=False)}")
    print(json.dumps(result, ensure_ascii=False))

    # 根据结果设置退出码
    exit_code = 0 if result['success'] else 1
    log(f"[INFO] 脚本退出，退出码: {exit_code}")
    sys.exit(exit_code)


if __name__ == '__main__':
    main()
