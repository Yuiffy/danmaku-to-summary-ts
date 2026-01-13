#!/usr/bin/env python3
"""
测试Hugging Face配置加载
"""

import os
import json
import sys

def test_huggingface_config():
    print("测试Hugging Face配置加载...")
    
    config_path = os.path.join(os.path.dirname(__file__), 'config.json')
    secrets_path = os.path.join(os.path.dirname(__file__), 'config.secrets.json')
    
    print(f"1. 检查配置文件: {config_path}")
    if os.path.exists(config_path):
        with open(config_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
        print("   [OK] 配置文件加载成功")
        
        # 检查代理配置
        proxy = config.get('aiServices', {}).get('huggingFace', {}).get('proxy', '')
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
        
        # 检查Hugging Face令牌
        hf_token = secrets.get('aiServices', {}).get('huggingFace', {}).get('apiToken', '')
        if hf_token and hf_token.strip():
            print("   [OK] Hugging Face令牌已配置")
            print(f"   令牌前10位: {hf_token[:10]}...")
            return True
        else:
            print("   [ERROR] Hugging Face令牌未配置或为空")
            return False
    else:
        print("   [ERROR] 密钥文件不存在")
        return False

def test_gradio_client():
    print("\n3. 测试gradio_client库...")
    try:
        from gradio_client import Client
        print("   [OK] gradio_client库可用")
        
        # 测试连接
        print("   测试连接到AI Comic Factory...")
        try:
            client = Client("jbilcke-hf/ai-comic-factory", verbose=False)
            print("   [OK] 成功连接到AI Comic Factory")
            return True
        except Exception as e:
            print(f"   [ERROR] 连接失败: {e}")
            return False
            
    except ImportError:
        print("   [ERROR] gradio_client库未安装")
        print("   请安装: pip install gradio_client")
        return False

def main():
    print("Hugging Face AI Comic Factory配置测试")
    print("=====================================\n")
    
    config_ok = test_huggingface_config()
    
    if config_ok:
        print("\n[INFO] 配置检查通过，开始测试API连接...")
        gradio_ok = test_gradio_client()
        
        if gradio_ok:
            print("\n[OK] 所有测试通过！Hugging Face配置正确。")
        else:
            print("\n[WARNING] API连接测试失败，请检查网络或代理设置。")
    else:
        print("\n[ERROR] 配置检查失败，请检查配置文件。")
    
    print("\n建议:")
    print("1. 确保config.secrets.json中的Hugging Face令牌正确")
    print("2. 确保代理服务器运行在 http://127.0.0.1:7890")
    print("3. 安装gradio_client: pip install gradio_client")
    print("4. 如果有网络问题，尝试关闭代理或使用其他代理")

if __name__ == "__main__":
    main()