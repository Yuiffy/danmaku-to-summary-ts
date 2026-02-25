#!/usr/bin/env python3
"""
tuZi Image Generations API 封装模块
用于图像生成功能的旧API支持（/v1/images/generations 端点）
备用方案，保留以备将来使用
"""

import os
import requests
import json
import base64
import time
from typing import Optional, Dict, Any
import traceback


def encode_image_to_base64(image_path: str, with_data_uri: bool = False) -> str:
    """将图片编码为base64

    Args:
        image_path: 图片路径
        with_data_uri: 是否添加 data:image/xxx;base64, 前缀
    """
    try:
        with open(image_path, "rb") as image_file:
            base64_data = base64.b64encode(image_file.read()).decode('utf-8')

        if with_data_uri:
            # 根据文件扩展名确定MIME类型
            ext = os.path.splitext(image_path)[1].lower()
            mime_map = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.webp': 'image/webp',
                '.gif': 'image/gif'
            }
            mime_type = mime_map.get(ext, 'image/png')
            return f"data:{mime_type};base64,{base64_data}"

        return base64_data
    except Exception as e:
        print(f"[ERROR] 图片编码失败: {e}")
        raise


def call_tuzi_image_generations(
    prompt: str,
    reference_image_path: Optional[str] = None,
    model: str = "gpt-image-1.5",
    base_url: str = "https://api.tu-zi.com",
    api_key: str = "",
    proxy_url: str = "",
    timeout: float = 360,
    size: str = "9x16",
    quality: str = "4k",
    style: str = "vivid"
) -> Optional[str]:
    """
    调用tuZi的/v1/images/generations端点生成图像
    旧API方式，备用方案

    Args:
        prompt: 图像生成提示词
        reference_image_path: 参考图片路径（可选）
        model: 模型名称
        base_url: API基础URL
        api_key: API密钥
        proxy_url: 代理URL
        timeout: 超时时间（秒）
        size: 图像尺寸
        quality: 图像质量
        style: 图像风格

    Returns:
        生成的图像文件路径，如果失败返回None
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
        api_url = f"{base_url}/v1/images/generations"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }

        # 构建请求体 - /v1/images/generations 格式
        payload = {
            "model": model,
            "prompt": prompt,
            "n": 1,
            "size": size,
            "quality": quality,
            "style": style
        }

        # 如果有参考图，添加到请求中
        if reference_image_path and os.path.exists(reference_image_path):
            # 使用 data URI 格式（data:image/png;base64,...）
            image_base64 = encode_image_to_base64(reference_image_path, with_data_uri=True)
            payload["image"] = [image_base64]
            print(f"[INFO]  已添加参考图到请求, base64长度: {len(image_base64)} 开头：{image_base64[:80]}...")

        # 重试逻辑
        max_retries = 3
        response = None

        for attempt in range(max_retries + 1):
            try:
                print(f"[WAIT] 正在通过tu-zi.com API生成图像... (尝试 {attempt + 1}/{max_retries + 1}, 超时: {timeout}s)")
                if attempt == 1:
                    payload["model"] = "gpt-image-1.5"
                    print(f"[RETRY] 第 {attempt + 1} 次重试...模型替换为{payload['model']}")
                elif attempt == 2:
                    payload["model"] = "gemini-2.5-flash-image-vip"
                    print(f"[RETRY] 第 {attempt + 1} 次重试...模型替换为{payload['model']}")
                elif (attempt == 3):
                    payload["model"] = "gemini-3-pro-image-preview/nano-banana-2"  # 含泪用2毛钱一次的超贵模型
                    print(f"[RETRY] 第 {attempt + 1} 次重试...模型替换为{payload['model']}，含泪用3毛钱一次的超贵模型")
                print(f"[DEBUG] 发起请求，内容：{json.dumps(payload)[:100]}..., 代理: {proxies}, 超时: {timeout}s")
                response = requests.post(api_url, headers=headers, json=payload, timeout=timeout, proxies=proxies)
                print(f"[DEBUG] 收到响应，状态码: {response.status_code}, 用时: {response.elapsed.total_seconds()}s")

                if response.status_code == 200:
                    # 尝试解析响应，如果解析失败则继续重试
                    result = response.json()

                    # 打印响应结构以便调试
                    print(f"[DEBUG] 响应结构: {list(result.keys())}")

                    # 处理 /v1/images/generations 响应格式 (OpenAI兼容格式)
                    if "data" in result and isinstance(result["data"], list) and len(result["data"]) > 0:
                        image_data = result["data"][0]

                        # 检查是否有URL
                        if "url" in image_data:
                            image_url = image_data["url"]
                            print(f"[DOWNLOAD] 下载生成的图像: {image_url}")
                            try:
                                image_response = requests.get(image_url, timeout=60, proxies=proxies)

                                if image_response.status_code == 200:
                                    import tempfile
                                    import uuid

                                    temp_dir = tempfile.gettempdir()
                                    temp_file = os.path.join(temp_dir, f"comic_tuzi_{uuid.uuid4().hex[:8]}.png")

                                    with open(temp_file, 'wb') as f:
                                        f.write(image_response.content)

                                    print(f"[OK] tu-zi.com图像生成成功")
                                    print(f"[SAVE] 图像已保存到临时文件: {temp_file}")
                                    return temp_file
                                else:
                                    print(f"[ERROR] 图像下载失败: HTTP {image_response.status_code}")
                                    # 下载失败，继续重试
                                    if attempt < max_retries:
                                        print("[RETRY] 2秒后重试...")
                                        time.sleep(2)
                                        continue
                                    return None
                            except Exception as download_error:
                                print(f"[ERROR] 图像下载异常: {download_error}")
                                # 下载异常，继续重试
                                if attempt < max_retries:
                                    print("[RETRY] 2秒后重试...")
                                    time.sleep(2)
                                    continue
                                return None

                        # 检查是否有base64编码的图像数据
                        elif "b64_json" in image_data:
                            image_base64 = image_data["b64_json"]
                            try:
                                image_data_bytes = base64.b64decode(image_base64)

                                import tempfile
                                import uuid

                                temp_dir = tempfile.gettempdir()
                                temp_file = os.path.join(temp_dir, f"comic_tuzi_{uuid.uuid4().hex[:8]}.png")

                                with open(temp_file, 'wb') as f:
                                    f.write(image_data_bytes)

                                print(f"[OK] tu-zi.com图像生成成功")
                                print(f"[SAVE] 图像已保存到临时文件: {temp_file}")
                                return temp_file
                            except Exception as decode_error:
                                print(f"[WARNING] 解码base64图像失败: {decode_error}")
                                # 解码失败，继续重试
                                if attempt < max_retries:
                                    print("[RETRY] 2秒后重试...")
                                    time.sleep(2)
                                    continue
                                return None

                    # 如果到这里还没返回，说明响应格式不符合预期（如 NO_IMAGE）
                    print(f"[ERROR] 无法从响应中提取图像数据")
                    print(f"[DEBUG] 完整响应: {json.dumps(result, ensure_ascii=False, indent=2)[:1000]}")
                    # 响应格式不符合预期，继续重试
                    if attempt < max_retries:
                        print("[RETRY] 2秒后重试...")
                        time.sleep(2)
                        continue
                    return None
                else:
                    print(f"[WARNING] tu-zi.com API调用失败 (尝试 {attempt + 1}): HTTP {response.status_code} elapsed: {response.elapsed.total_seconds()}s")
                    if attempt < max_retries:
                        print("[RETRY] 2秒后重试...")
                        time.sleep(2)
            except Exception as req_err:
                print(f"[WARNING] 请求异常 (尝试 {attempt + 1}): {req_err}")
                if attempt < max_retries:
                    print("[RETRY] 2秒后重试...")
                    time.sleep(2)

        # 如果彻底失败且response为None (即全是Exception)，手动return避免后续AttributeError
        if response is None:
             print("[ERROR] 所有重试均抛出异常，无API响应")
             return None

    except Exception as e:
        print(f"[ERROR] tu-zi.com图像生成失败: {e}")
        traceback.print_exc()
        return None
