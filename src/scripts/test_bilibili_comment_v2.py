#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试修改后的bilibili_comment.py脚本
"""

import json
import asyncio
import sys
import os

# 添加src/scripts目录到Python路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from scripts.bilibili_comment import get_dynamic_comment_id

async def test_get_dynamic_comment_id():
    """测试获取动态的comment_id"""
    dynamic_id = '1153657516031213571'

    print(f"=== 测试获取动态的comment_id ===")
    print(f"动态ID: {dynamic_id}\n")

    try:
        comment_id, comment_type = await get_dynamic_comment_id(dynamic_id)
        print(f"comment_id: {comment_id}")
        print(f"comment_type: {comment_type}")
        print(f"comment_type.value: {comment_type.value}")
        print("\n测试成功！")
    except Exception as e:
        print(f"测试失败: {e}")
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    asyncio.run(test_get_dynamic_comment_id())
