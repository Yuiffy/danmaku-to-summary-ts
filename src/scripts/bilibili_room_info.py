#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
获取B站直播间信息
"""

import sys
import json
from bilibili_api import live, Credential

async def get_room_info(room_id: str, sessdata: str, bili_jct: str, dedeuserid: str):
    """
    获取直播间信息

    Args:
        room_id: 直播间ID
        sessdata: SESSDATA
        bili_jct: bili_jct
        dedeuserid: DedeUserID

    Returns:
        dict: 直播间信息
    """
    try:
        # 创建凭据
        credential = Credential(
            sessdata=sessdata,
            bili_jct=bili_jct,
            dedeuserid=dedeuserid
        )

        # 创建直播间对象
        room = live.LiveRoom(
            room_display_id=int(room_id),
            credential=credential
        )

        # 获取直播间信息
        info = await room.get_room_info()

        print('[OK] 获取直播间信息成功', file=sys.stderr)
        return {
            'success': True,
            'data': info
        }
    except Exception as e:
        print(f'[ERROR] 获取直播间信息失败: {str(e)}', file=sys.stderr)
        return {
            'success': False,
            'error': str(e)
        }

if __name__ == '__main__':
    import asyncio

    if len(sys.argv) < 5:
        print(json.dumps({
            'success': False,
            'error': '参数不足: room_id sessdata bili_jct dedeuserid'
        }))
        sys.exit(1)

    room_id = sys.argv[1]
    sessdata = sys.argv[2]
    bili_jct = sys.argv[3]
    dedeuserid = sys.argv[4]

    result = asyncio.run(get_room_info(room_id, sessdata, bili_jct, dedeuserid))
    print(json.dumps(result, ensure_ascii=False))
