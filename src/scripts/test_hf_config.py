#!/usr/bin/env python3
"""
测试Gemini配置加载
"""

import os
import json
import sys

def test_gemini_config():
    print("测试Gemini配置加载...")

    config_path = os.path.join(os.path.dirname(__file__), 'config.json')
    secrets_path = os.path.join(os.path.dirname(__file__), 'config.secrets.json')

    print(f"1. 检查配置文件: {config_path}")
    if os.path.exists(config_path):
        with open(config_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
        print("   [OK] 配置文件加载成功")

        # 检查代理配置
        proxy = config.get('aiServices', {}).get('gemini', {}).get('proxy', '')
        if proxy:
            print(f"   [OK] 代理配置: {proxy}")
        else:
            print("   [WARNING] 未配置代理")
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
            print(f"   密钥前10位: {gemini_key[:10]}...")
            return True
        else:
            print("   [ERROR] Gemini API密钥未配置或为空")
            return False
    else:
        print("   [ERROR] 密钥文件不存在")
        return False

def test_gemini_client():
    print("\n3. 测试google-generativeai库...")
    try:
        import google.generativeai as genai
        print("   [OK] google-generativeai库可用")

        # 测试配置
        print("   测试Gemini配置...")
        try:
            secrets_path = os.path.join(os.path.dirname(__file__), 'config.secrets.json')
            with open(secrets_path, 'r', encoding='utf-8') as f:
                secrets = json.load(f)
            gemini_key = secrets.get('aiServices', {}).get('gemini', {}).get('apiKey', '')
            if gemini_key:
                genai.configure(api_key=gemini_key)
                print("   [OK] Gemini API密钥配置成功")
                return True
            else:
                print("   [ERROR] Gemini API密钥未找到")
                return False
        except Exception as e:
            print(f"   [ERROR] 配置失败: {e}")
            return False

    except ImportError:
        print("   [ERROR] google-generativeai库未安装")
        print("   请安装: pip install google-generativeai")
        return False

def main():
    print("Gemini配置测试")
    print("=============\n")

    config_ok = test_gemini_config()

    if config_ok:
        print("\n[INFO] 配置检查通过，开始测试API...")
        gemini_ok = test_gemini_client()

        if gemini_ok:
            print("\n[OK] 所有测试通过！Gemini配置正确。")
        else:
            print("\n[WARNING] API测试失败，请检查API密钥。")
    else:
        print("\n[ERROR] 配置检查失败，请检查配置文件。")

    print("\n建议:")
    print("1. 确保config.secrets.json中的Gemini API密钥正确")
    print("2. 确保代理服务器运行在 http://127.0.0.1:7890")
    print("3. 安装google-generativeai: pip install google-generativeai")
    print("4. 如果有网络问题，尝试关闭代理或使用其他代理")

if __name__ == "__main__":
    main()