#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
获取B站直播间弹幕连接信息
"""

import sys
import json
import asyncio
from urllib.parse import urlsplit
from bilibili_api import live, Credential
from bilibili_api.utils.network import request_settings, request_log


def parse_cookie(cookie: str) -> dict:
    fields = {}
    for part in cookie.split(';'):
        name, separator, value = part.strip().partition('=')
        if separator and name not in fields:
            fields[name] = value.strip()
    return fields


async def get_danmu_info(room_id: str, sessdata: str, bili_jct: str, dedeuserid: str,
                        buvid3: str = None, buvid4: str = None):
    """
    获取直播间弹幕连接信息
    """
    api_paths = []

    def on_api_request(_description, request):
        # RequestLog also contains cookies and signed query parameters. Retain
        # only the endpoint path so a rejected prerequisite is not mislabeled
        # as a getDanmuInfo failure.
        api_paths.append(urlsplit(request.get('url', '')).path)

    request_log.add_event_listener('API_REQUEST', on_api_request)
    try:
        required = {'SESSDATA': sessdata, 'bili_jct': bili_jct, 'DedeUserID': dedeuserid,
                    'buvid3': buvid3, 'buvid4': buvid4}
        missing = [name for name, value in required.items() if not value]
        if missing:
            return {'success': False, 'code': -1, 'error': 'Cookie缺少必要参数: ' + ', '.join(missing)}

        # This is a short-lived probe. Reuse the supplied device identity and
        # never create/activate a new one on each monitoring pass.
        request_settings.set_enable_auto_buvid(False)
        credential = Credential(
            sessdata=sessdata,
            bili_jct=bili_jct,
            dedeuserid=dedeuserid,
            buvid3=buvid3,
            buvid4=buvid4
        )

        room = live.LiveRoom(
            room_display_id=int(room_id),
            credential=credential
        )

        info = await room.get_danmu_info()

        print('[OK] 获取直播间弹幕信息成功', file=sys.stderr)
        return {
            'success': True,
            'code': 0,
            'data': {'server_count': len(info.get('host_list', []))}
        }
    except Exception as e:
        code = getattr(e, 'code', None)
        code = code if isinstance(code, int) else -1
        # Upstream exceptions can contain request details. Log only a safe
        # classification; the probe does not need to return the websocket token.
        endpoint = api_paths[-1] if api_paths else None
        message = f'接口返回错误代码: {code}' if code != -1 else f'弹幕接口检查失败: {type(e).__name__}'
        if endpoint:
            message += f'，接口: {endpoint}'
        print(f'[ERROR] {message}', file=sys.stderr)
        return {
            'success': False,
            'code': code,
            'error': message,
            'endpoint': endpoint
        }
    finally:
        request_log.remove_event_listener('API_REQUEST', on_api_request)
        if api_paths:
            print('[INFO] 弹幕探针API调用链: ' + ' -> '.join(api_paths), file=sys.stderr)


def read_credentials(argv, stdin) -> tuple:
    if len(argv) == 3 and argv[2] == '--credential-stdin':
        fields = parse_cookie(json.load(stdin)['cookie'])
    elif len(argv) >= 5:
        # Compatibility for an already-running service during an upgrade.
        # Only borrow device fields when the configured login matches exactly.
        from config_loader import get_config
        configured = parse_cookie(get_config().get('bilibili', {}).get('cookie', ''))
        fields = dict(zip(['SESSDATA', 'bili_jct', 'DedeUserID'], argv[2:5]))
        if all(fields.get(key) == configured.get(key) for key in fields):
            fields.update({key: configured.get(key) for key in ['buvid3', 'buvid4']})
    else:
        raise ValueError('Invalid probe arguments')
    return (argv[1], *(fields.get(key) for key in ['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4']))


if __name__ == '__main__':
    try:
        args = read_credentials(sys.argv, sys.stdin)
        result = asyncio.run(get_danmu_info(*args))
    except Exception:
        result = {'success': False, 'code': -1, 'error': '无法读取弹幕探针凭据'}
    print(json.dumps(result, ensure_ascii=False))
