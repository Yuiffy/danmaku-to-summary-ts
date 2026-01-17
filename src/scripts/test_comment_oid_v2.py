#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试B站动态评论，验证正确的oid和type
"""

import json
import asyncio
from bilibili_api import comment, Credential

async def test_comment_oid():
    """测试动态评论，验证正确的oid和type"""
    # 使用真实的动态ID进行测试
    dynamic_id = '1153657516031213571'
    comment_id = '380296536'  # 从API返回的comment_id_str

    print(f"=== 测试动态ID: {dynamic_id} ===")
    print(f"=== 评论ID: {comment_id} ===\n")

    # 尝试使用comment_id作为oid，DYNAMIC_DRAW作为type获取评论
    try:
        comments = await comment.get_comments(
            oid=int(comment_id),
            type_=comment.CommentResourceType.DYNAMIC_DRAW
        )
        print("=== 使用comment_id作为oid，DYNAMIC_DRAW作为type获取评论成功 ===")
        print(f"评论数量: {len(comments.get('replies', []))}")
        if comments.get('replies'):
            print("第一条评论:")
            print(json.dumps(comments['replies'][0], indent=2, ensure_ascii=False))
    except Exception as e:
        print(f"使用comment_id作为oid，DYNAMIC_DRAW作为type获取评论失败: {e}")

    # 尝试使用dynamic_id作为oid，DYNAMIC_DRAW作为type获取评论
    try:
        comments = await comment.get_comments(
            oid=int(dynamic_id),
            type_=comment.CommentResourceType.DYNAMIC_DRAW
        )
        print("\n=== 使用dynamic_id作为oid，DYNAMIC_DRAW作为type获取评论成功 ===")
        print(f"评论数量: {len(comments.get('replies', []))}")
        if comments.get('replies'):
            print("第一条评论:")
            print(json.dumps(comments['replies'][0], indent=2, ensure_ascii=False))
    except Exception as e:
        print(f"使用dynamic_id作为oid，DYNAMIC_DRAW作为type获取评论失败: {e}")

    # 尝试使用comment_id作为oid，DYNAMIC作为type获取评论
    try:
        comments = await comment.get_comments(
            oid=int(comment_id),
            type_=comment.CommentResourceType.DYNAMIC
        )
        print("\n=== 使用comment_id作为oid，DYNAMIC作为type获取评论成功 ===")
        print(f"评论数量: {len(comments.get('replies', []))}")
        if comments.get('replies'):
            print("第一条评论:")
            print(json.dumps(comments['replies'][0], indent=2, ensure_ascii=False))
    except Exception as e:
        print(f"使用comment_id作为oid，DYNAMIC作为type获取评论失败: {e}")

if __name__ == '__main__':
    asyncio.run(test_comment_oid())
