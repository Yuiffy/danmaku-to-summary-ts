#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试B站API的CommentResourceType枚举
"""

from bilibili_api import comment

print("=== CommentResourceType 枚举值 ===")
for attr in dir(comment.CommentResourceType):
    if not attr.startswith('_'):
        value = getattr(comment.CommentResourceType, attr)
        print(f"{attr} = {value}")
