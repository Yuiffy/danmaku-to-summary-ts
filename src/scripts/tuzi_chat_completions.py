#!/usr/bin/env python3
"""
tuZi Chat Completions API 封装模块
用于文本生成和聊天功能的旧API支持
"""

import os
import requests
import json
import base64
import time
import re
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


def call_tuzi_chat_completions_for_image(
    prompt: str,
    reference_image_path = None,  # 可以是单个路径(str)或多个路径(list)
    model: str = "gpt-image-1.5",
    base_url: str = "https://api.tu-zi.com",
    api_key: str = "",
    proxy_url: str = "",
    timeout: float = 360,
    temperature: float = 0.7,
    max_tokens: int = 100000
) -> Optional[str]:
    """
    调用tuZi的/v1/chat/completions端点生成图像

    Args:
        prompt: 图像生成提示词
        reference_image_path: 参考图片路径，可以是单个路径(str)或多个路径(list)
        model: 模型名称
        base_url: API基础URL
        api_key: API密钥
        proxy_url: 代理URL
        timeout: 超时时间（秒）
        temperature: 温度参数
        max_tokens: 最大生成令牌数

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
        api_url = f"{base_url}/v1/chat/completions"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }

        # 构建消息列表
        messages = []

        # 处理参考图片（支持单张或多张）
        reference_images = []
        if reference_image_path:
            # 统一转换为列表格式
            if isinstance(reference_image_path, str):
                reference_images = [reference_image_path] if os.path.exists(reference_image_path) else []
            elif isinstance(reference_image_path, list):
                reference_images = [img for img in reference_image_path if os.path.exists(img)]
        
        # 如果有参考图，添加到消息中
        if reference_images:
            # 构建包含所有图片的消息内容
            content_parts = [{"type": "text", "text": "请参考以下图片的风格和角色形象："}]
            
            for idx, img_path in enumerate(reference_images, 1):
                # 使用 data URI 格式（data:image/png;base64,...）
                image_base64 = encode_image_to_base64(img_path, with_data_uri=True)
                content_parts.append({
                    "type": "image_url", 
                    "image_url": {"url": image_base64}
                })
                print(f"[INFO]  已添加参考图 {idx}/{len(reference_images)}: {os.path.basename(img_path)}, base64长度: {len(image_base64)}")
            
            messages.append({
                "role": "user",
                "content": content_parts
            })
            print(f"[INFO]  共添加 {len(reference_images)} 张参考图到请求")

        # 添加图像生成提示词
        messages.append({
            "role": "user",
            "content": prompt
        })

        # 模型重试逻辑
        models_to_try = [model]
        # 补充备选模型（去重）
        fallbacks = ["gpt-image-1.5", "gemini-2.5-flash-image-vip", "gemini-3-pro-image-preview/nano-banana-2"]
        for fb in fallbacks:
            if fb not in models_to_try:
                models_to_try.append(fb)

        response = None
        for attempt, current_model in enumerate(models_to_try):
            try:
                print(f"[WAIT] 正在通过tu-zi.com API生成图像... (尝试 {attempt + 1}/{len(models_to_try)}, 超时: {timeout}s, 模型: {current_model})")

                # 构建请求体 - /v1/chat/completions 格式
                payload = {
                    "model": current_model,
                    "messages": messages,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                }

                print(f"[DEBUG] 发起请求，内容：{json.dumps(payload)[:100]}..., 代理: {proxies}, 超时: {timeout}s")
                response = requests.post(api_url, headers=headers, json=payload, timeout=timeout, proxies=proxies)
                print(f"[DEBUG] 收到响应，状态码: {response.status_code}, 用时: {response.elapsed.total_seconds()}s")

                if response.status_code == 200:
                    # 尝试解析响应
                    result = response.json()

                    # 打印响应结构以便调试
                    print(f"[DEBUG] 响应结构: {list(result.keys())}")

                    # 处理 /v1/chat/completions 响应格式
                    if "choices" in result and len(result["choices"]) > 0:
                        choice = result["choices"][0]
                        message = choice.get("message", {})
                        content = message.get("content", "")

                        # 检查是否包含图像URL
                        if content and isinstance(content, str):
                            # 1. 优先检查是否有异步任务链接 (AsyncData / tuZi 格式)
                            # 格式如: [原始数据](https://pro.asyncdata.net/source/xxxx)
                            async_task_match = re.search(r'\[原始数据\]\((https?://[^)]+/source/[^)]+)\)', content)
                            if async_task_match:
                                task_url = async_task_match.group(1)
                                print(f"[INFO] 检测到异步生成任务: {task_url}")
                                
                                # 轮询任务状态
                                import tempfile
                                import uuid
                                
                                start_time = time.time()
                                while time.time() - start_time < timeout:
                                    try:
                                        task_resp = requests.get(task_url, proxies=proxies, timeout=30)
                                        
                                        if task_resp.status_code == 200:
                                            try:
                                                task_data = task_resp.json()
                                                task_status = task_data.get("status")
                                                
                                                if task_status == "completed" or (task_status is None and "urls" in task_data):
                                                    # 任务完成
                                                    image_urls = task_data.get("urls", [])
                                                    # 备选：从generations获取
                                                    if not image_urls and "generations" in task_data:
                                                        gens = task_data.get("generations", [])
                                                        if gens and len(gens) > 0:
                                                            if isinstance(gens[0], dict):
                                                                if "url" in gens[0]:
                                                                    image_urls.append(gens[0]["url"])
                                                                elif "img_paths" in gens[0]:
                                                                    image_urls.extend(gens[0]["img_paths"])
                                                    
                                                    if image_urls and len(image_urls) > 0:
                                                        final_image_url = image_urls[0]
                                                        print(f"[DOWNLOAD] 异步任务完成，下载图像: {final_image_url}")
                                                        
                                                        # 下载图片
                                                        img_res = requests.get(final_image_url, timeout=60, proxies=proxies)
                                                        if img_res.status_code == 200:
                                                            temp_dir = tempfile.gettempdir()
                                                            temp_file = os.path.join(temp_dir, f"comic_tuzi_async_{uuid.uuid4().hex[:8]}.png")
                                                            with open(temp_file, 'wb') as f:
                                                                f.write(img_res.content)
                                                            print(f"[OK] tu-zi.com图像生成成功 (异步)")
                                                            print(f"[SAVE] 图像已保存到临时文件: {temp_file}")
                                                            return temp_file
                                                        else:
                                                            print(f"[ERROR] 下载图像失败: HTTP {img_res.status_code}")
                                                            # 下载失败通常无法恢复，退出循环
                                                            break
                                                    else:
                                                        print(f"[ERROR] 任务显示完成但未找到URL: {task_data.keys()}")
                                                        break
                                                        
                                                elif task_status == "failed":
                                                    print(f"[ERROR] 异步任务生成失败: {task_data.get('failure_reason', '未知原因')}")
                                                    break
                                                else:
                                                    print(f"[WAIT] 任务进行中... (状态: {task_status})")
                                                    time.sleep(3)
                                            except json.JSONDecodeError:
                                                print(f"[WARNING] 任务响应非JSON格式")
                                                time.sleep(3)
                                        else:
                                            print(f"[WARNING] 获取任务状态HTTP错误: {task_resp.status_code}")
                                            time.sleep(3)
                                            
                                    except Exception as poll_err:
                                        print(f"[WARNING] 轮询出错: {poll_err}")
                                        time.sleep(3)
                                
                                # 循环结束检查
                                if time.time() - start_time >= timeout:
                                    print(f"[ERROR] 异步任务轮询超时 ({timeout}s)")

                            # 2. 尝试从内容中提取直接图像URL (旧逻辑)
                            url_match = re.search(r'https?://[^\s\)]+\.(?:png|jpg|jpeg|webp)', content)
                            if url_match:
                                image_url = url_match.group(0)
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
                                except Exception as download_error:
                                    print(f"[ERROR] 图像下载异常: {download_error}")

                            # 检查是否包含base64编码的图像数据
                            b64_match = re.search(r'data:image/[a-z]+;base64,([A-Za-z0-9+/=]+)', content)
                            if b64_match:
                                image_base64 = b64_match.group(1)
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

                        # 检查是否有工具调用（某些API可能通过工具返回图像）
                        tool_calls = message.get("tool_calls", [])
                        if tool_calls:
                            for tool_call in tool_calls:
                                if tool_call.get("type") == "function":
                                    function_args = tool_call.get("function", {}).get("arguments", "{}")
                                    try:
                                        args_json = json.loads(function_args)
                                        if "image_url" in args_json:
                                            image_url = args_json["image_url"]
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
                                            except Exception as download_error:
                                                print(f"[ERROR] 图像下载异常: {download_error}")
                                    except Exception as json_error:
                                        print(f"[WARNING] 解析工具调用参数失败: {json_error}")

                    # 如果到这里还没返回，说明响应格式不符合预期
                    print(f"[ERROR] 无法从响应中提取图像数据")
                    print(f"[DEBUG] 完整响应: {json.dumps(result, ensure_ascii=False, indent=2)[:1000]}")
                else:
                    print(f"[WARNING] tu-zi.com API调用失败 (尝试 {attempt + 1}/{len(models_to_try)}): HTTP {response.status_code} elapsed: {response.elapsed.total_seconds()}s")
                
                # 如果没成功且还有剩余模型，等待一下再试
                if attempt < len(models_to_try) - 1:
                    print("[RETRY] 2秒后更换模型重试...")
                    time.sleep(2)

            except Exception as req_err:
                print(f"[ERROR] 请求异常 (尝试 {attempt + 1}/{len(models_to_try)}): {req_err}")
                if attempt < len(models_to_try) - 1:
                    print("[RETRY] 2秒后更换模型重试...")
                    time.sleep(2)
        
        return None

    except Exception as e:
        print(f"[ERROR] tu-zi.com图像生成失败: {e}")
        traceback.print_exc()
        return None
