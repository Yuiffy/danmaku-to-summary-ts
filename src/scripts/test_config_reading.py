#!/usr/bin/env python3
"""
测试Python脚本读取新格式配置
"""

import sys
import os
sys.path.append(os.path.dirname(__file__))

from ai_comic_generator import load_config, is_tuzi_configured

def test_config_reading():
    print("测试配置读取...")
    
    # 加载配置
    config = load_config()
    
    print(f"配置加载成功: {bool(config)}")
    print(f"配置键: {list(config.keys())}")
    
    # 检查aiServices
    if "aiServices" in config:
        print(f"aiServices: {config['aiServices']}")
        if "tuZi" in config["aiServices"]:
            print(f"tuZi配置: {config['aiServices']['tuZi']}")
    
    # 检查ai（新格式）
    if "ai" in config:
        print(f"ai配置: {config['ai']}")
    
    # 检查tuZi是否配置
    print(f"tuZi是否配置: {is_tuzi_configured()}")
    
    # 测试房间配置
    print(f"房间设置: {config.get('roomSettings', {})}")
    
    return config

if __name__ == "__main__":
    test_config_reading()