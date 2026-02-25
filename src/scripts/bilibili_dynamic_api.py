#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B站动态API脚本
获取指定UID的动态列表，支持时间范围筛选
"""

import sys
import json
import asyncio
from datetime import datetime
from bilibili_api import dynamic, Credential

# 禁用输出缓冲
_original_stdout = sys.stdout
_original_stderr = sys.stderr

def log(*args, **kwargs):
    """日志输出到stderr"""
    message = ' '.join(str(arg) for arg in args)
    try:
        if not _original_stderr.closed:
            _original_stderr.write(message + '\\n')
            _original_stderr.flush()
    except (ValueError, OSError, AttributeError):
        pass

def json_print(*args, **kwargs):
    """JSON打印函数，只输出到stdout"""
    message = ' '.join(str(arg) for arg in args)
    try:
        if not _original_stdout.closed:
            _original_stdout.write(message + '\\n')
            _original_stdout.flush()
    except (ValueError, OSError, AttributeError):
        pass

async def get_dynamics_in_timerange(uid: str, start_time: datetime, end_time: datetime, credential: Credential):
    """获取指定时间范围内的动态
    
    Args:
        uid: 用户UID
        start_time: 开始时间
        end_time: 结束时间
        credential: B站凭证
        
    Returns:
        list: 动态列表，每个动态包含id、type、content、publishTime等字段
    """
    log(f"[INFO] 获取UID {uid} 在 {start_time} 到 {end_time} 之间的动态")
    
    try:
        # 获取用户动态
        user_dynamic = dynamic.Dynamic(credential=credential)
        
        # 获取动态列表（默认获取最近的动态）
        dynamics_data = await user_dynamic.get_user_dynamics(uid=int(uid))
        
        log(f"[INFO] 获取到 {len(dynamics_data.get('cards', []))} 条动态")
        
        # 解析动态
        result_dynamics = []
        for card_data in dynamics_data.get('cards', []):
            try:
                # 获取动态ID
                dynamic_id = card_data.get('desc', {}).get('dynamic_id_str', '')
                
                # 获取发布时间（Unix时间戳）
                timestamp = card_data.get('desc', {}).get('timestamp', 0)
                publish_time = datetime.fromtimestamp(timestamp)
                
                # 检查是否在时间范围内
                if start_time <= publish_time <= end_time:
                    # 获取动态类型
                    dynamic_type = card_data.get('desc', {}).get('type', 0)
                    
                    # 获取动态内容（简化版）
                    card_str = card_data.get('card', '{}')
                    card_content = json.loads(card_str) if isinstance(card_str, str) else card_str
                    
                    # 提取文本内容
                    content = ''
                    if 'item' in card_content:
                        content = card_content['item'].get('content', '') or card_content['item'].get('description', '')
                    elif 'dynamic' in card_content:
                        content = card_content['dynamic']
                    
                    result_dynamics.append({
                        'id': dynamic_id,
                        'type': dynamic_type,
                        'content': content[:200],  # 限制长度
                        'publishTime': publish_time.isoformat(),
                        'timestamp': timestamp
                    })
                    
                    log(f"[INFO] 找到符合条件的动态: {dynamic_id}, 发布时间: {publish_time}")
                
            except Exception as e:
                log(f"[WARNING] 解析动态失败: {e}")
                continue
        
        log(f"[INFO] 共找到 {len(result_dynamics)} 条符合时间范围的动态")
        return result_dynamics
        
    except Exception as e:
        log(f"[ERROR] 获取动态失败: {e}")
        import traceback
        traceback.print_exc(file=_original_stderr)
        return []

async def main_async():
    """异步主函数"""
    if len(sys.argv) < 6:
        log("[ERROR] 参数不足")
        log("用法: python bilibili_dynamic_api.py <uid> <start_time> <end_time> <sessdata> <bili_jct> <dedeuserid>")
        log("时间格式: ISO 8601 (例如: 2026-01-23T20:00:00)")
        json_print(json.dumps({
            'success': False,
            'error': '参数不足',
            'dynamics': []
        }, ensure_ascii=False))
        sys.exit(1)
    
    uid = sys.argv[1]
    start_time_str = sys.argv[2]
    end_time_str = sys.argv[3]
    sessdata = sys.argv[4]
    bili_jct = sys.argv[5]
    dedeuserid = sys.argv[6]
    
    try:
        # 解析时间
        start_time = datetime.fromisoformat(start_time_str)
        end_time = datetime.fromisoformat(end_time_str)
        
        log(f"[INFO] 查询参数: UID={uid}, 开始时间={start_time}, 结束时间={end_time}")
        
        # 创建凭证
        credential = Credential(
            sessdata=sessdata,
            bili_jct=bili_jct,
            dedeuserid=dedeuserid
        )
        
        # 获取动态
        dynamics = await get_dynamics_in_timerange(uid, start_time, end_time, credential)
        
        # 输出结果
        result = {
            'success': True,
            'dynamics': dynamics,
            'count': len(dynamics)
        }
        
        json_print(json.dumps(result, ensure_ascii=False))
        
    except Exception as e:
        log(f"[ERROR] 执行失败: {e}")
        import traceback
        traceback.print_exc(file=_original_stderr)
        
        json_print(json.dumps({
            'success': False,
            'error': str(e),
            'dynamics': []
        }, ensure_ascii=False))
        sys.exit(1)

def main():
    """主函数"""
    asyncio.run(main_async())

if __name__ == '__main__':
    main()
