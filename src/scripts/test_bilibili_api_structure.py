#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试bilibili-api返回的数据结构
"""

import json
from bilibili_api.dynamic import get_info

dynamic_id = '1153657516031213571'
info = get_info(dynamic_id)

print("Keys:", info.keys())
print("\n=== DESC ===")
desc = info.get('desc', {})
print("DESC Keys:", desc.keys() if hasattr(desc, 'keys') else desc)
print("\nFull DESC:")
print(json.dumps(desc, indent=2, ensure_ascii=False))
