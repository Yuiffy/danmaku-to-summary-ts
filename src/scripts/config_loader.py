#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统一配置加载器 - Python版本
用于所有Python脚本加载配置
读取优先级和密钥映射由 core/config/config-contract.json 定义。
"""

import os
import sys
import json
from typing import Dict, Any, Optional
import config_contract

# 禁用输出缓冲，确保日志实时输出到Node.js
import io
# 保存原始的stdout/stderr，以便在包装失败时使用
_original_stdout = sys.stdout
_original_stderr = sys.stderr

# 创建安全的打印函数，确保日志能够输出
def safe_print(*args, **kwargs):
    """安全的打印函数，尝试多种方式输出日志"""
    message = ' '.join(str(arg) for arg in args)
    
    # 尝试1: 使用原始stdout
    try:
        if not _original_stdout.closed:
            _original_stdout.write(message + '\n')
            _original_stdout.flush()
            return
    except (ValueError, OSError, AttributeError):
        pass
    
    # 尝试2: 使用内置print
    try:
        __builtins__.print(*args, **kwargs)
        return
    except (ValueError, OSError, AttributeError):
        pass
    
    # 尝试3: 直接写入sys.stdout
    try:
        if hasattr(sys.stdout, 'write') and not sys.stdout.closed:
            sys.stdout.write(message + '\n')
            sys.stdout.flush()
            return
    except (ValueError, OSError, AttributeError):
        pass
    
    # 尝试4: 写入stderr作为最后手段
    try:
        if hasattr(sys.stderr, 'write') and not sys.stderr.closed:
            sys.stderr.write(message + '\n')
            sys.stderr.flush()
            return
    except (ValueError, OSError, AttributeError):
        pass

# 全局替换内置print函数
print = safe_print


def get_project_root() -> str:
    return os.path.abspath(os.environ.get("DANMAKU_PROJECT_ROOT") or os.path.join(os.path.dirname(__file__), "../.."))


def find_config_paths() -> list:
    return config_contract.find_config_paths(get_project_root())


def find_config_path() -> str:
    """
    查找主配置文件路径（返回最后一个，即最高优先级）
    """
    paths = find_config_paths()
    return paths[-1] if paths else os.path.join(get_project_root(), 'config', 'default.json')


def find_secrets_path() -> str:
    """
    查找secrets配置文件路径
    位置: /config/secret.json
    """
    project_root = get_project_root()
    return os.path.join(project_root, 'config', 'secret.json')


def deep_merge(target: Dict[str, Any], source: Dict[str, Any]) -> Dict[str, Any]:
    return config_contract.deep_merge(target, source)


def read_json_file(file_path: str) -> Dict[str, Any]:
    return config_contract.read_json_object(file_path)


def get_config(force_reload: bool = False) -> Dict[str, Any]:
    return config_contract.load_config_layers(get_project_root())


def get_gemini_api_key() -> str:
    """获取Gemini API Key"""
    config = get_config()
    return config.get('ai', {}).get('text', {}).get('gemini', {}).get('apiKey', '')


def get_tuzi_api_key() -> str:
    """获取tuZi API Key"""
    config = get_config()
    return config.get('ai', {}).get('comic', {}).get('tuZi', {}).get('apiKey', '')


def get_tuzi_text_api_key() -> str:
    """获取 tuZi 文本生成 API Key"""
    config = get_config()
    text_config = config.get('ai', {}).get('text', {}).get('tuZi', {})
    return text_config.get('apiKey', '') or get_tuzi_api_key()


def is_tuzi_text_configured() -> bool:
    api_key = get_tuzi_text_api_key()
    return bool(api_key and api_key.strip())


def is_gemini_configured() -> bool:
    """检查Gemini是否配置"""
    api_key = get_gemini_api_key()
    return bool(api_key and api_key.strip())


def is_tuzi_configured() -> bool:
    """检查tuZi是否配置"""
    api_key = get_tuzi_api_key()
    return bool(api_key and api_key.strip())


def get_room_names(room_id: Optional[str] = None) -> Dict[str, str]:
    """
    获取主播和粉丝名称
    
    Args:
        room_id: 房间ID，如果提供则返回房间特定的名称
        
    Returns:
        包含 'anchor' 和 'fan' 的字典
    """
    config = get_config()
    
    # 获取默认名称
    anchor = config.get('ai', {}).get('defaultNames', {}).get('anchor', '主播')
    fan = config.get('ai', {}).get('defaultNames', {}).get('fan', '粉丝')
    
    # 如果提供了房间ID，尝试获取房间特定的名称
    if room_id:
        room_str = str(room_id)
        room_settings = config.get('ai', {}).get('roomSettings', {}).get(room_str, {})
        if room_settings.get('anchorName'):
            anchor = room_settings['anchorName']
        if room_settings.get('fanName'):
            fan = room_settings['fanName']
    
    return {'anchor': anchor, 'fan': fan}


if __name__ == '__main__':
    """测试配置加载"""
    print("=" * 50)
    print("测试统一配置加载器")
    print("=" * 50)
    
    config = get_config()
    
    print("\n✓ 配置加载成功")
    print(f"✓ 应用名称: {config.get('app', {}).get('name', 'N/A')}")
    print(f"✓ Gemini配置: {'已配置' if is_gemini_configured() else '未配置'}")
    print(f"✓ tuZi配置: {'已配置' if is_tuzi_configured() else '未配置'}")
    
    # 测试房间名称
    names = get_room_names()
    print(f"✓ 默认名称 - 主播: {names['anchor']}, 粉丝: {names['fan']}")
    
    names_26966466 = get_room_names('26966466')
    print(f"✓ 房间26966466 - 主播: {names_26966466['anchor']}, 粉丝: {names_26966466['fan']}")
    
    print("\n配置路径:")
    print(f"  主配置: {find_config_path()}")
    print(f"  Secrets: {find_secrets_path()}")
