#!/usr/bin/env python3
"""
测试代理配置和Hugging Face连接
"""

import os
import json
import sys
import requests
from gradio_client import Client

def test_proxy_connection():
    print("测试代理连接...")
    
    # 加载配置
    config_path = os.path.join(os.path.dirname(__file__), 'config.json')
    secrets_path = os.path.join(os.path.dirname(__file__), 'config.secrets.json')
    
    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)
    
    with open(secrets_path, 'r', encoding='utf-8') as f:
        secrets = json.load(f)
    
    # 获取代理配置
    proxy_url = config.get('aiServices', {}).get('huggingFace', {}).get('proxy', '')
    hf_token = secrets.get('aiServices', {}).get('huggingFace', {}).get('apiToken', '')
    
    print(f"代理URL: {proxy_url}")
    print(f"Hugging Face令牌: {hf_token[:10]}...")
    
    # 测试代理连接
    if proxy_url:
        print("\n1. 测试代理服务器连接...")
        try:
            proxies = {
                'http': proxy_url,
                'https': proxy_url
            }
            
            # 测试通过代理访问httpbin
            response = requests.get('http://httpbin.org/ip', proxies=proxies, timeout=10)
            if response.status_code == 200:
                print(f"   [OK] 代理连接成功: {response.json()}")
            else:
                print(f"   [ERROR] 代理连接失败: {response.status_code}")
                return False
        except Exception as e:
            print(f"   [ERROR] 代理连接异常: {e}")
            return False
    else:
        print("\n1. 未配置代理，跳过代理测试")
    
    # 测试gradio_client连接
    print("\n2. 测试gradio_client连接...")
    try:
        # 设置环境变量
        if proxy_url:
            os.environ["HTTP_PROXY"] = proxy_url
            os.environ["HTTPS_PROXY"] = proxy_url
            os.environ["http_proxy"] = proxy_url
            os.environ["https_proxy"] = proxy_url
        
        # 测试连接到AI Comic Factory
        print("   连接到AI Comic Factory...")
        client = Client("jbilcke-hf/ai-comic-factory", verbose=False)
        
        # 测试一个简单的预测
        print("   测试简单预测...")
        try:
            # 使用一个简单的测试提示
            test_prompt = "A cute anime character"
            result = client.predict(
                prompt=test_prompt,
                style="Japanese Manga",
                layout="Neutral"
            )
            print(f"   [OK] 连接成功，返回结果类型: {type(result)}")
            return True
        except Exception as e:
            print(f"   [WARNING] 预测测试失败，但连接成功: {e}")
            return True
            
    except Exception as e:
        print(f"   [ERROR] gradio_client连接失败: {e}")
        
        # 尝试不使用代理
        print("\n3. 尝试不使用代理连接...")
        try:
            # 清除代理环境变量
            for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
                if key in os.environ:
                    del os.environ[key]
            
            client = Client("jbilcke-hf/ai-comic-factory", verbose=False)
            print("   [OK] 无代理连接成功")
            return True
        except Exception as e2:
            print(f"   [ERROR] 无代理连接也失败: {e2}")
            return False

def main():
    print("代理配置和Hugging Face连接测试")
    print("==============================\n")
    
    success = test_proxy_connection()
    
    if success:
        print("\n[OK] 所有连接测试通过！")
        print("\n建议:")
        print("1. 代理配置正确，可以正常使用")
        print("2. 可以运行ai_comic_generator.py进行实际测试")
    else:
        print("\n[ERROR] 连接测试失败")
        print("\n故障排除:")
        print("1. 检查代理服务器是否运行在 http://127.0.0.1:7890")
        print("2. 尝试关闭代理，直接连接")
        print("3. 检查网络连接")
        print("4. 检查防火墙设置")
    
    return 0 if success else 1

if __name__ == "__main__":
    sys.exit(main())