#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
获取B站直播间弹幕连接信息
"""

import sys
import json
import asyncio
from bilibili_api import live, Credential


async def get_danmu_info(room_id: str, sessdata: str, bili_jct: str, dedeuserid: str):
    """
    获取直播间弹幕连接信息
    """
    try:
        credential = Credential(
            sessdata=sessdata,
            bili_jct=bili_jct,
            dedeuserid=dedeuserid
        )

        room = live.LiveRoom(
            room_display_id=int(room_id),
            credential=credential
        )

        info = await room.get_danmu_info()

        print('[OK] 获取直播间弹幕信息成功', file=sys.stderr)
        return {
            'success': True,
            'data': info
        }
    except Exception as e:
        print(f'[ERROR] 获取直播间弹幕信息失败: {str(e)}', file=sys.stderr)
        return {
            'success': False,
            'error': str(e)
        }


if __name__ == '__main__':
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

    result = asyncio.run(get_danmu_info(room_id, sessdata, bili_jct, dedeuserid))
    print(json.dumps(result, ensure_ascii=False))
