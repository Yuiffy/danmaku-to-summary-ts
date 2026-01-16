#!/usr/bin/env python3
"""
tuZi Chat Completions API 封装模块
用于文本生成和聊天功能的旧API支持
"""

import os
import requests
import json
from typing import Optional, Dict, Any
import traceback


def call_tuzi_chat_completions(
    prompt: str,
    system_prompt: Optional[str] = None,
    model: str = "gemini-3-flash-preview",
    base_url: str = "https://api.tu-zi.com",
    api_key: str = "",
    proxy_url: str = "",
    timeout: float = 120,
    temperature: float = 0.7,
    max_tokens: int = 100000
) -> Optional[str]:
    """
    调用tuZi的/v1/chat/completions端点生成文本
    
    Args:
        prompt: 用户提示词
        system_prompt: 系统提示词
        model: 模型名称
        base_url: API基础URL
        api_key: API密钥
        proxy_url: 代理URL
        timeout: 超时时间（秒）
        temperature: 温度参数
        max_tokens: 最大生成令牌数
        
    Returns:
        生成的文本内容，如果失败返回None
    """
    try:
        # 设置代理
        proxies = {}
        if proxy_url:
            proxies = {
                "http": proxy_url,
                "https": proxy_url
            }
            print(f"[PROXY] 使用代理: {proxy_url}")

        # 构建API请求
        api_url = f"{base_url}/v1/chat/completions"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }

        # 构建消息列表
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        print(f"[TUZI_TEXT] 调用tuZi Chat Completions API...")
        response = requests.post(api_url, headers=headers, json=payload, timeout=timeout, proxies=proxies)

        if response.status_code == 200:
            result = response.json()
            if "choices" in result and len(result["choices"]) > 0:
                content = result["choices"][0].get("message", {}).get("content", "")
                if content and content.strip():
                    print("[OK] tuZi Chat Completions 文本生成成功")
                    print(f"生成内容长度: {len(content)} 字符")
                    return content.strip()
                else:
                    print("[WARNING]  tuZi API返回空内容")
                    return None
            else:
                print(f"[WARNING]  tuZi API响应格式异常: {result}")
                return None
        else:
            print(f"[WARNING]  tuZi Chat Completions API调用失败: HTTP {response.status_code}")
            print(f"响应内容: {response.text[:500]}")
            return None

    except Exception as e:
        print(f"[ERROR]  tuZi Chat Completions API调用失败: {e}")
        traceback.print_exc()
        return None
