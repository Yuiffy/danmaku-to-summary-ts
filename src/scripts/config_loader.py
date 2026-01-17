#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统一配置加载器 - Python版本
用于所有Python脚本加载配置
读取优先级: config/production.json > config/default.json，然后合并 config/secret.json
"""

import os
import sys
import json
from typing import Dict, Any, Optional

# 禁用输出缓冲，确保日志实时输出到Node.js
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', line_buffering=True)


def get_project_root() -> str:
    """获取项目根目录"""
    # 脚本在 src/scripts 目录
    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(scripts_dir))


def find_config_path() -> str:
    """
    查找配置文件路径
    优先级: /config/production.json > /config/default.json
    """
    env = os.environ.get('NODE_ENV', 'development')
    project_root = get_project_root()
    config_dir = os.path.join(project_root, 'config')
    
    possible_paths = [
        # 优先读取外部config目录中的环境特定配置
        os.path.join(config_dir, 'production.json' if env == 'production' else 'default.json'),
        # 其次读取外部config目录中的默认配置
        os.path.join(config_dir, 'default.json'),
    ]
    
    for config_path in possible_paths:
        if os.path.exists(config_path):
            return config_path
    
    # 默认返回 config/default.json
    return os.path.join(config_dir, 'default.json')


def find_secrets_path() -> str:
    """
    查找secrets配置文件路径
    位置: /config/secret.json
    """
    project_root = get_project_root()
    return os.path.join(project_root, 'config', 'secret.json')


def deep_merge(target: Dict[str, Any], source: Dict[str, Any]) -> Dict[str, Any]:
    """深度合并两个字典"""
    result = target.copy()
    
    for key, value in source.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    
    return result


def read_json_file(file_path: str) -> Dict[str, Any]:
    """读取JSON文件"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        raise Exception(f"Failed to read JSON file {file_path}: {e}")


def get_config(force_reload: bool = False) -> Dict[str, Any]:
    """
    获取完整配置（合并主配置和secrets）
    
    Args:
        force_reload: 是否强制重新加载，忽略缓存
    """
    config_path = find_config_path()
    secrets_path = find_secrets_path()
    
    # 读取主配置
    config = {}
    if os.path.exists(config_path):
        config = read_json_file(config_path)
        print(f"✓ 配置文件已加载: {config_path}")
    else:
        print(f"⚠ 配置文件不存在: {config_path}")
    
    # 读取secrets并合并
    if os.path.exists(secrets_path):
        secrets = read_json_file(secrets_path)
        # 将扁平的secrets结构映射到嵌套结构
        mapped_secrets = {}
        
        # gemini.apiKey -> ai.text.gemini.apiKey
        if 'gemini' in secrets and 'apiKey' in secrets['gemini']:
            if 'ai' not in mapped_secrets:
                mapped_secrets['ai'] = {}
            if 'text' not in mapped_secrets['ai']:
                mapped_secrets['ai']['text'] = {}
            if 'gemini' not in mapped_secrets['ai']['text']:
                mapped_secrets['ai']['text']['gemini'] = {}
            mapped_secrets['ai']['text']['gemini']['apiKey'] = secrets['gemini']['apiKey']
        
        # tuZi.apiKey -> ai.comic.tuZi.apiKey
        if 'tuZi' in secrets and 'apiKey' in secrets['tuZi']:
            if 'ai' not in mapped_secrets:
                mapped_secrets['ai'] = {}
            if 'comic' not in mapped_secrets['ai']:
                mapped_secrets['ai']['comic'] = {}
            if 'tuZi' not in mapped_secrets['ai']['comic']:
                mapped_secrets['ai']['comic']['tuZi'] = {}
            mapped_secrets['ai']['comic']['tuZi']['apiKey'] = secrets['tuZi']['apiKey']
        
        # bilibili -> bilibili
        if 'bilibili' in secrets:
            mapped_secrets['bilibili'] = secrets['bilibili']
        
        # 合并映射后的secrets
        config = deep_merge(config, mapped_secrets)
        print(f"✓ Secrets配置文件已加载: {secrets_path}")
    else:
        print(f"⚠ Secrets配置文件不存在: {secrets_path}")
    
    return config


def get_gemini_api_key() -> str:
    """获取Gemini API Key"""
    config = get_config()
    return config.get('ai', {}).get('text', {}).get('gemini', {}).get('apiKey', '')


def get_tuzi_api_key() -> str:
    """获取tuZi API Key"""
    config = get_config()
    return config.get('ai', {}).get('comic', {}).get('tuZi', {}).get('apiKey', '')


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
