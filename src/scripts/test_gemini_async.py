#!/usr/bin/env python3
"""
测试 Gemini 异步 API 的简单脚本
"""

import sys
import os

# 添加脚本目录到路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))

from config_loader import load_config
from tuzi_gemini_async import call_tuzi_gemini_async


def test_gemini_async_simple():
    """简单测试 Gemini 异步 API"""
    
    # 加载配置
    config = load_config()
    
    # 获取 API 配置
    tuzi_config = config.get('ai', {}).get('comic', {}).get('tuZi', {})
    api_key = tuzi_config.get('apiKey', '')
    base_url = tuzi_config.get('baseUrl', 'https://api.tu-zi.com')
    proxy_url = tuzi_config.get('proxy', None)
    
    if not api_key:
        print("[ERROR] 未配置 tuZi API 密钥")
        return False
    
    # 测试提示词
    test_prompt = "一只可爱的小猫咪在草地上玩耍，阳光明媚，画面温馨"
    
    print("=" * 60)
    print("测试 Gemini 异步 API")
    print("=" * 60)
    print(f"提示词: {test_prompt}")
    print(f"API Base URL: {base_url}")
    print(f"代理: {proxy_url if proxy_url else '无'}")
    print("=" * 60)
    
    # 调用 API
    result = call_tuzi_gemini_async(
        prompt=test_prompt,
        reference_image_paths=None,
        model="gemini-3-pro-image-preview-async",
        base_url=base_url,
        api_key=api_key,
        proxy_url=proxy_url,
        timeout=60,
        size="1:1",
        max_poll_time=300
    )
    
    if result:
        print("\n" + "=" * 60)
        print("✅ 测试成功！")
        print(f"生成的图像保存在: {result}")
        print("=" * 60)
        return True
    else:
        print("\n" + "=" * 60)
        print("❌ 测试失败")
        print("=" * 60)
        return False


if __name__ == "__main__":
    success = test_gemini_async_simple()
    sys.exit(0 if success else 1)
