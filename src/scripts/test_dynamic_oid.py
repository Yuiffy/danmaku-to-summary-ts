#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试B站动态API，获取正确的oid用于评论
"""

import json
import asyncio
from bilibili_api import comment, dynamic, Credential

async def test_dynamic_structure():
    """测试动态数据结构，找到正确的oid"""
    dynamic_id = '1153657516031213571'

    print(f"=== 测试动态ID: {dynamic_id} ===\n")

    # 获取动态信息
    try:
        info = await dynamic.get_dynamic_info(dynamic_id)
        print("=== 动态信息 ===")
        print(json.dumps(info, indent=2, ensure_ascii=False))
    except Exception as e:
        print(f"获取动态信息失败: {e}")

    # 尝试获取动态评论
    try:
        comments = await comment.get_comments(
            oid=int(dynamic_id),
            type_=comment.CommentResourceType.DYNAMIC
        )
        print("\n=== 动态评论 ===")
        print(f"评论数量: {len(comments.get('replies', []))}")
        if comments.get('replies'):
            print("第一条评论:")
            print(json.dumps(comments['replies'][0], indent=2, ensure_ascii=False))
    except Exception as e:
        print(f"获取动态评论失败: {e}")

    # 尝试使用不同的oid
    print("\n=== 尝试不同的oid ===")
    # B站动态评论的oid可能是dynamic_id，也可能是其他字段
    # 让我们尝试解析动态URL中的ID
    # 动态URL格式: https://www.bilibili.com/opus/{dynamic_id}
    # 评论API的oid可能需要使用dynamic_id

if __name__ == '__main__':
    asyncio.run(test_dynamic_structure())
