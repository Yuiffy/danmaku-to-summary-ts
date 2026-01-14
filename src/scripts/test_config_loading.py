#!/usr/bin/env python3
"""
测试配置加载
"""

import os
import json
import sys

def test_config_loading():
    print("测试配置加载...")
    
    config_path = os.path.join(os.path.dirname(__file__), 'config.json')
    secrets_path = os.path.join(os.path.dirname(__file__), 'config.secrets.json')
    
    print(f"1. 检查配置文件: {config_path}")
    if os.path.exists(config_path):
        with open(config_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
        print("   [OK] 配置文件加载成功")
        
        # 检查Gemini配置
        gemini_config = config.get('aiServices', {}).get('gemini', {})
        print(f"   Gemini enabled: {gemini_config.get('enabled', False)}")
        print(f"   Proxy: {gemini_config.get('proxy', '未配置')}")
        print(f"   Model: {gemini_config.get('model', '未配置')}")
    else:
        print("   [ERROR] 配置文件不存在")
        return False

    print(f"\n2. 检查密钥文件: {secrets_path}")
    if os.path.exists(secrets_path):
        with open(secrets_path, 'r', encoding='utf-8') as f:
            secrets = json.load(f)
        print("   [OK] 密钥文件加载成功")

        # 检查Gemini API密钥
        gemini_key = secrets.get('aiServices', {}).get('gemini', {}).get('apiKey', '')
        if gemini_key and gemini_key.strip():
            print("   [OK] Gemini API密钥已配置")
            print(f"   密钥长度: {len(gemini_key)} 字符")
            print(f"   密钥前10位: {gemini_key[:10]}...")
            return True
        else:
            print("   [ERROR] Gemini API密钥未配置或为空")
            return False
    else:
        print("   [ERROR] 密钥文件不存在")
        return False

def test_ai_comic_generator_config():
    print("\n3. 测试ai_comic_generator.py配置加载...")
    try:
        # 导入ai_comic_generator的配置函数
        sys.path.insert(0, os.path.dirname(__file__))
        from ai_comic_generator import load_config

        config = load_config()
        print("   [OK] load_config()成功")

        print(f"   Config keys: {list(config.keys())}")

        gemini_config = config.get('aiServices', {}).get('gemini', {})
        print(f"   Gemini config: {gemini_config}")

        print("   [OK] 配置加载测试通过")
        return True

    except Exception as e:
        print(f"   [ERROR] 导入失败: {e}")
        import traceback
        traceback.print_exc()
        return False

def main():
    print("配置加载测试")
    print("============\n")
    
    config_ok = test_config_loading()
    
    if config_ok:
        print("\n[INFO] 基本配置检查通过，测试ai_comic_generator配置...")
        generator_ok = test_ai_comic_generator_config()
        
        if generator_ok:
            print("\n[OK] 所有配置测试通过！")
        else:
            print("\n[ERROR] ai_comic_generator配置测试失败")
            print("\n可能的问题:")
            print("1. config.secrets.json格式不正确")
            print("2. ai_comic_generator.py中的load_config()函数有问题")
            print("3. 文件编码问题")
    else:
        print("\n[ERROR] 基本配置检查失败")
    
    print("\n建议:")
    print("1. 检查config.secrets.json文件格式")
    print("2. 确保Gemini API密钥正确")
    print("3. 检查文件编码是否为UTF-8")

if __name__ == "__main__":
    main()