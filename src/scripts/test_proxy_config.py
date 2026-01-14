#!/usr/bin/env python3
"""
测试代理配置
"""

import os
import json
import sys
import requests

def test_proxy_connection():
    print("测试代理连接...")

    # 加载配置
    config_path = os.path.join(os.path.dirname(__file__), 'config.json')

    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)

    # 获取代理配置 (从Gemini配置中获取)
    proxy_url = config.get('aiServices', {}).get('gemini', {}).get('proxy', '')

    print(f"代理URL: {proxy_url}")

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
                return True
            else:
                print(f"   [ERROR] 代理连接失败: {response.status_code}")
                return False
        except Exception as e:
            print(f"   [ERROR] 代理连接异常: {e}")
            return False
    else:
        print("\n1. 未配置代理，跳过代理测试")
        return True

def main():
    print("代理配置测试")
    print("===========\n")

    success = test_proxy_connection()

    if success:
        print("\n[OK] 代理连接测试通过！")
        print("\n建议:")
        print("1. 代理配置正确，可以正常使用")
    else:
        print("\n[ERROR] 连接测试失败")
        print("\n故障排除:")
        print("1. 检查代理服务器是否运行在 http://127.0.0.1:7890")
        print("2. 检查网络连接")
        print("3. 检查防火墙设置")

    return 0 if success else 1

if __name__ == "__main__":
    sys.exit(main())