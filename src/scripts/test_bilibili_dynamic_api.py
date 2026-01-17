#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试B站动态API，获取正确的oid用于评论
"""

import json
import asyncio
import aiohttp

async def test_dynamic_api():
    """测试动态API，获取正确的oid"""
    # 使用一个真实的动态ID进行测试
    dynamic_id = '1153657516031213571'

    print(f"=== 测试动态ID: {dynamic_id} ===\n")

    # 获取动态详情
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
            print("=== 动态详情 ===")
            print(json.dumps(data, indent=2, ensure_ascii=False))

            # 检查返回的数据结构
            if data.get('code') == 0:
                item = data.get('data', {}).get('item', {})
                print("\n=== 动态item结构 ===")
                print(json.dumps(item, indent=2, ensure_ascii=False))

                # 查找可能的oid字段
                print("\n=== 可能的oid字段 ===")
                if 'desc' in item:
                    desc = item['desc']
                    print(f"desc.dynamic_id_str: {desc.get('dynamic_id_str')}")
                    print(f"desc.dynamic_id: {desc.get('dynamic_id')}")
                    print(f"desc.rid: {desc.get('rid')}")
                    print(f"desc.type: {desc.get('type')}")
                    print(f"desc.oid: {desc.get('oid')}")

                if 'card' in item:
                    card = item['card']
                    if isinstance(card, str):
                        card = json.loads(card)
                    print(f"\ncard中的字段:")
                    print(f"card.id: {card.get('id')}")
                    print(f"card.item.id: {card.get('item', {}).get('id')}")

if __name__ == '__main__':
    asyncio.run(test_dynamic_api())
