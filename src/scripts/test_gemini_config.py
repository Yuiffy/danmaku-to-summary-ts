#!/usr/bin/env python3
"""
测试Gemini配置读取
"""

import json
import os
import sys

def test_gemini_config():
    """测试Gemini配置读取"""
    print("测试Gemini配置读取...")
    
    # 检查文件
    config_path = 'config.json'
    secrets_path = 'config.secrets.json'
    
    print(f"config.json 存在: {os.path.exists(config_path)}")
    print(f"config.secrets.json 存在: {os.path.exists(secrets_path)}")
    
    # 读取config.json
    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)
    
    print("\n=== config.json ===")
    print("aiServices.gemini 存在:", 'aiServices' in config and 'gemini' in config['aiServices'])
    if 'aiServices' in config and 'gemini' in config['aiServices']:
        gemini_config = config['aiServices']['gemini']
        print("gemini配置:")
        print(f"  enabled: {gemini_config.get('enabled', '未设置')}")
        print(f"  model: {gemini_config.get('model', '未设置')}")
        print(f"  temperature: {gemini_config.get('temperature', '未设置')}")
        print(f"  maxTokens: {gemini_config.get('maxTokens', '未设置')}")
        print(f"  proxy: {gemini_config.get('proxy', '未设置')}")
        print(f"  apiKey: {gemini_config.get('apiKey', '未设置')}")
    
    # 读取config.secrets.json
    with open(secrets_path, 'r', encoding='utf-8') as f:
        secrets = json.load(f)
    
    print("\n=== config.secrets.json ===")
    print("ai.text.gemini 存在:", 'ai' in secrets and 'text' in secrets['ai'] and 'gemini' in secrets['ai']['text'])
    if 'ai' in secrets and 'text' in secrets['ai'] and 'gemini' in secrets['ai']['text']:
        gemini_secrets = secrets['ai']['text']['gemini']
        print("gemini密钥配置:")
        print(f"  apiKey: {gemini_secrets.get('apiKey', '未设置')}")
        print(f"  apiKey长度: {len(gemini_secrets.get('apiKey', ''))}")
    
    # 测试Python脚本中的load_config函数
    print("\n=== 测试Python脚本中的load_config函数 ===")
    try:
        # 导入ai_comic_generator中的load_config函数
        sys.path.insert(0, os.path.dirname(__file__))
        from ai_comic_generator import load_config
        
        merged_config = load_config()
        print("load_config() 调用成功")
        
        if 'aiServices' in merged_config and 'gemini' in merged_config['aiServices']:
            merged_gemini = merged_config['aiServices']['gemini']
            print("合并后的gemini配置:")
            print(f"  enabled: {merged_gemini.get('enabled', '未设置')}")
            print(f"  model: {merged_gemini.get('model', '未设置')}")
            print(f"  apiKey: {merged_gemini.get('apiKey', '未设置')}")
            print(f"  apiKey长度: {len(merged_gemini.get('apiKey', ''))}")
            print(f"  proxy: {merged_gemini.get('proxy', '未设置')}")
        else:
            print("合并后的配置中没有aiServices.gemini")
            
    except Exception as e:
        print(f"导入或调用load_config失败: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    test_gemini_config()