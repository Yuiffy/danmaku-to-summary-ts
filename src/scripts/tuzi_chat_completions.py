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
import mimetypes
from typing import Optional, Dict, Any
import traceback
import tempfile
import uuid

# 导入 Gemini 异步 API 模块
try:
    from tuzi_gemini_async import call_tuzi_gemini_async
except ImportError:
    print("[WARNING] 无法导入 tuzi_gemini_async 模块，Gemini异步功能将不可用")
    call_tuzi_gemini_async = None


def model_supports_chinese(model: str) -> bool:
    """判断模型是否支持在图像中生成汉字
    
    Args:
        model: 模型名称
        
    Returns:
        True 如果模型支持汉字，False 否则
    """
    if not model:
        return False
    
    # 高级模型列表（支持汉字）
    advanced_models = [
        "gpt-image-2",
        "gpt-image-1.5",
        "gemini-3-pro-image-preview-async",
        "gemini-3-pro-image-preview/nano-banana-2",
        "gemini-3-pro-image-preview-2k-async",
        "gemini-3-pro-image-preview-4k-async",
    ]
    
    # 检查模型名称是否在高级模型列表中
    for advanced_model in advanced_models:
        if advanced_model in model:
            return True
    
    return False


def get_chinese_instruction(model: str) -> str:
    """根据模型能力获取汉字相关的指令文本
    
    Args:
        model: 模型名称
        
    Returns:
        汉字指令文本
    """
    if model_supports_chinese(model):
        return "可以加入适量、清晰、排版工整的中文文字来增强漫画叙事，比如短台词、吐槽、标题、小标签、拟声词。优先使用自然中文，单处文字尽量简短，控制在1到12个字，整张图的文字数量要克制但可以比以前稍多，像成熟漫画分镜那样服务画面，不要做成大段说明书。"
    else:
        return "尽量不要有汉字，除非就一两个字。"


def save_image_bytes(image_bytes: bytes, prefix: str = "comic_tuzi") -> str:
    """将图像字节写入临时文件并返回路径。"""
    temp_dir = tempfile.gettempdir()
    temp_file = os.path.join(temp_dir, f"{prefix}_{uuid.uuid4().hex[:8]}.png")
    with open(temp_file, 'wb') as f:
        f.write(image_bytes)
    print(f"[SAVE] 图像已保存到临时文件: {temp_file}")
    return temp_file


def normalize_image_url(image_url: str) -> str:
    """从 markdown/混合文本里提取可直接下载的图片 URL。"""
    if not isinstance(image_url, str):
        return image_url

    markdown_target = re.search(r'\]\((https?://[^)\s]+\.(?:png|jpg|jpeg|webp))\)', image_url)
    if markdown_target:
        return markdown_target.group(1)

    markdown_target = re.search(r'\]\((https?://[^)\s]+\.(?:png|jpg|jpeg|webp))', image_url)
    if markdown_target:
        return markdown_target.group(1)

    direct_match = re.search(r'https?://[^\s\]\)]+\.(?:png|jpg|jpeg|webp)', image_url)
    if direct_match:
        return direct_match.group(0)

    return image_url.strip()


def download_image_to_temp(image_url: str, proxies: Dict[str, str], prefix: str = "comic_tuzi") -> Optional[str]:
    """下载图片到临时文件。"""
    image_url = normalize_image_url(image_url)
    print(f"[DOWNLOAD] 下载生成的图像: {image_url}")
    try:
        image_response = requests.get(image_url, timeout=60, proxies=proxies)
        if image_response.status_code == 200:
            print(f"[OK] tu-zi.com图像生成成功")
            return save_image_bytes(image_response.content, prefix=prefix)
        print(f"[ERROR] 图像下载失败: HTTP {image_response.status_code}")
        return None
    except Exception as download_error:
        print(f"[ERROR] 图像下载异常: {download_error}")
        return None


def try_extract_image_from_data_items(data_items, proxies: Dict[str, str], prefix: str = "comic_tuzi") -> Optional[str]:
    """兼容 OpenAI /images 响应风格的数据结构。"""
    if not isinstance(data_items, list) or not data_items:
        return None

    image_data = data_items[0]
    if not isinstance(image_data, dict):
        return None

    if image_data.get("url"):
        return download_image_to_temp(image_data["url"], proxies, prefix=prefix)

    if image_data.get("b64_json"):
        try:
            image_bytes = base64.b64decode(image_data["b64_json"])
            print(f"[OK] tu-zi.com图像生成成功")
            return save_image_bytes(image_bytes, prefix=prefix)
        except Exception as decode_error:
            print(f"[WARNING] 解码b64_json图像失败: {decode_error}")
            return None

    if image_data.get("image_url"):
        return download_image_to_temp(image_data["image_url"], proxies, prefix=prefix)

    return None


def try_extract_image_from_message_content(content, proxies: Dict[str, str], timeout: float) -> Optional[str]:
    """兼容 chat/completions 返回的多种 message.content 结构。"""
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            image_url = item.get("image_url") or item.get("url")
            if image_url:
                result = download_image_to_temp(image_url, proxies)
                if result:
                    return result
            b64_json = item.get("b64_json")
            if b64_json:
                try:
                    image_bytes = base64.b64decode(b64_json)
                    print(f"[OK] tu-zi.com图像生成成功")
                    return save_image_bytes(image_bytes)
                except Exception as decode_error:
                    print(f"[WARNING] 解码content中的b64_json失败: {decode_error}")

    if not isinstance(content, str) or not content:
        return None

    async_task_match = re.search(r'\[原始数据\]\((https?://[^)]+/source/[^)]+)\)', content)
    if async_task_match:
        task_url = async_task_match.group(1)
        print(f"[INFO] 检测到异步生成任务: {task_url}")

        start_time = time.time()
        while time.time() - start_time < timeout:
            try:
                task_resp = requests.get(task_url, proxies=proxies, timeout=30)

                if task_resp.status_code == 200:
                    try:
                        task_data = task_resp.json()
                        task_status = task_data.get("status")

                        if task_status == "completed" or (task_status is None and "urls" in task_data):
                            image_urls = task_data.get("urls", [])
                            if not image_urls and "generations" in task_data:
                                gens = task_data.get("generations", [])
                                if gens and isinstance(gens[0], dict):
                                    if "url" in gens[0]:
                                        image_urls.append(gens[0]["url"])
                                    elif "img_paths" in gens[0]:
                                        image_urls.extend(gens[0]["img_paths"])

                            if image_urls:
                                return download_image_to_temp(image_urls[0], proxies, prefix="comic_tuzi_async")

                            print(f"[ERROR] 任务显示完成但未找到URL: {task_data.keys()}")
                            return None

                        if task_status == "failed":
                            print(f"[ERROR] 异步任务生成失败: {task_data.get('failure_reason', '未知原因')}")
                            return None

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

        print(f"[ERROR] 异步任务轮询超时 ({timeout}s)")

    normalized_url = normalize_image_url(content)
    if isinstance(normalized_url, str) and normalized_url.startswith("http"):
        return download_image_to_temp(normalized_url, proxies)

    b64_match = re.search(r'data:image/[a-z]+;base64,([A-Za-z0-9+/=]+)', content)
    if b64_match:
        try:
            image_data_bytes = base64.b64decode(b64_match.group(1))
            print(f"[OK] tu-zi.com图像生成成功")
            return save_image_bytes(image_data_bytes)
        except Exception as decode_error:
            print(f"[WARNING] 解码base64图像失败: {decode_error}")

    return None


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


def normalize_gpt_image_size(size: str) -> str:
    """gpt-image-2 edits/generations 官方格式使用像素尺寸，兼容旧的比例写法。"""
    ratio_to_pixels = {
        "1:1": "1024x1024",
        "2:3": "1024x1536",
        "3:2": "1536x1024",
        "16:9": "2048x1152",
        "9:16": "1024x1792",
    }
    return ratio_to_pixels.get(size, size)


def call_tuzi_images_edits(
    prompt: str,
    reference_image_path,
    model: str = "gpt-image-2",
    base_url: str = "https://api.tu-zi.com",
    api_key: str = "",
    proxy_url: str = "",
    timeout: float = 360,
    size: str = "1024x1024",
    quality: str = "high",
    output_format: str = "png",
) -> Optional[str]:
    """
    调用 /v1/images/edits 端点生成参考图编辑/多图融合结果。
    gpt-image-2 的参考图输入必须以 multipart/form-data 的 image[] 文件上传。
    """
    try:
        proxies = {}
        if proxy_url:
            proxies = {"http": proxy_url, "https": proxy_url}
            print(f"[PROXY] 使用代理: {proxy_url}")

        if isinstance(reference_image_path, str):
            reference_paths = [reference_image_path]
        else:
            reference_paths = list(reference_image_path or [])

        reference_paths = [path for path in reference_paths if path and os.path.exists(path)]
        if not reference_paths:
            print("[WARNING] images/edits 缺少有效参考图，跳过")
            return None

        if len(reference_paths) > 5:
            print(f"[WARNING] gpt-image-2 edits 最多支持 5 张参考图，当前 {len(reference_paths)} 张，仅使用前 5 张")
            reference_paths = reference_paths[:5]

        api_url = f"{base_url}/v1/images/edits"
        headers = {
            "Authorization": f"Bearer {api_key}",
        }
        data = {
            "model": model,
            "prompt": prompt,
            "size": normalize_gpt_image_size(size),
            "quality": quality,
            "output_format": output_format,
        }

        opened_files = []
        files = []
        try:
            for idx, img_path in enumerate(reference_paths, 1):
                mime_type = mimetypes.guess_type(img_path)[0] or "application/octet-stream"
                file_obj = open(img_path, "rb")
                opened_files.append(file_obj)
                files.append(("image[]", (os.path.basename(img_path), file_obj, mime_type)))
                file_size = os.path.getsize(img_path)
                print(f"[INFO]  已添加参考图 {idx}/{len(reference_paths)} 到 images/edits: {os.path.basename(img_path)}, {file_size} bytes, {mime_type}")

            print(f"[INFO] [images/edits] 调用 {model}, size={data['size']}, quality={quality}, output_format={output_format}, prompt长度={len(prompt)}")
            resp = requests.post(api_url, headers=headers, data=data, files=files, timeout=timeout, proxies=proxies)
        finally:
            for file_obj in opened_files:
                file_obj.close()

        print(f"[DEBUG] images/edits 响应状态码: {resp.status_code}, 用时: {resp.elapsed.total_seconds()}s")

        if resp.status_code != 200:
            print(f"[ERROR] images/edits 失败: HTTP {resp.status_code}, body: {resp.text[:500]}")
            return None

        result = resp.json()
        print(f"[DEBUG] images/edits 响应结构: {list(result.keys())}")

        extracted = try_extract_image_from_data_items(result.get("data"), proxies, prefix=f"comic_{model.replace('/', '_')}_edit")
        if extracted:
            print(f"[OK] images/edits 成功，保存到: {extracted}")
            return extracted

        print(f"[ERROR] images/edits 响应中未找到图片数据: {json.dumps(result, ensure_ascii=False)[:500]}")
        return None

    except Exception as e:
        print(f"[ERROR] images/edits 异常: {e}")
        traceback.print_exc()
        return None


def call_tuzi_images_generations(
    prompt: str,
    reference_image_path = None,
    model: str = "gpt-image-2",
    base_url: str = "https://api.tu-zi.com",
    api_key: str = "",
    proxy_url: str = "",
    timeout: float = 360,
    size: str = "1:1",
    n: int = 1,
    response_format: str = "b64_json",
    quality: str = "high",
    output_format: str = "png"
) -> Optional[str]:
    """
    调用 /v1/images/generations 端点生成图像（OpenAI DALL-E 兼容格式）
    专用于 gpt-image-2 / gpt-image-1.5 等图片生成模型

    Args:
        prompt: 图像生成提示词
        reference_image_path: 参考图片路径；有参考图时自动改用 /v1/images/edits
        model: 模型名称
        base_url: API基础URL
        api_key: API密钥
        proxy_url: 代理URL
        timeout: 超时时间（秒）
        size: 图像尺寸，如 "1:1", "2:3", "3:2" 等
        n: 生成图像数量
        response_format: 返回格式，"b64_json" 或 "url"

    Returns:
        生成的图像文件路径，如果失败返回None
    """
    try:
        proxies = {}
        if proxy_url:
            proxies = {"http": proxy_url, "https": proxy_url}
            print(f"[PROXY] 使用代理: {proxy_url}")

        api_url = f"{base_url}/v1/images/generations"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }

        if reference_image_path:
            if isinstance(reference_image_path, str):
                reference_image_path = [reference_image_path]
            valid_reference_images = [img_path for img_path in reference_image_path if os.path.exists(img_path)]
            if valid_reference_images:
                print(f"[INFO] 检测到 {len(valid_reference_images)} 张参考图，使用 /v1/images/edits multipart 上传")
                return call_tuzi_images_edits(
                    prompt=prompt,
                    reference_image_path=valid_reference_images,
                    model=model,
                    base_url=base_url,
                    api_key=api_key,
                    proxy_url=proxy_url,
                    timeout=timeout,
                    size=size,
                    quality=quality,
                    output_format=output_format,
                )

        payload = {
            "model": model,
            "prompt": prompt,
            "n": n,
            "size": normalize_gpt_image_size(size),
            "response_format": response_format,
            "quality": quality,
            "output_format": output_format,
        }

        print(f"[INFO] [images/generations] 调用 {model}, size={payload['size']}, prompt长度={len(prompt)}")
        print(f"[DEBUG] payload: model={model}, size={payload['size']}, n={n}, response_format={response_format}, quality={quality}, output_format={output_format}")

        resp = requests.post(api_url, headers=headers, json=payload, timeout=timeout, proxies=proxies)
        print(f"[DEBUG] 响应状态码: {resp.status_code}, 用时: {resp.elapsed.total_seconds()}s")

        if resp.status_code != 200:
            print(f"[ERROR] images/generations 失败: HTTP {resp.status_code}, body: {resp.text[:500]}")
            return None

        result = resp.json()
        print(f"[DEBUG] 响应结构: {list(result.keys())}")

        # 标准返回格式: { "data": [ { "b64_json": "...", "url": "..." } ] }
        data_list = result.get("data", [])
        if not data_list:
            print(f"[ERROR] 响应中无 data 字段: {json.dumps(result, ensure_ascii=False)[:500]}")
            return None

        first = data_list[0]

        # 优先 b64_json
        b64 = first.get("b64_json")
        if b64:
            import base64
            image_bytes = base64.b64decode(b64)
            output_path = save_image_bytes(image_bytes, prefix=f"comic_{model.replace('/', '_')}")
            if output_path:
                print(f"[OK] images/generations 成功，保存到: {output_path}")
                return output_path

        # 其次 url
        img_url = first.get("url")
        if img_url:
            downloaded = download_image_to_temp(img_url, proxies, prefix=f"comic_{model.replace('/', '_')}")
            if downloaded:
                print(f"[OK] images/generations 成功（URL模式），保存到: {downloaded}")
                return downloaded

        print(f"[ERROR] data[0] 中无 b64_json 也无 url: {json.dumps(first, ensure_ascii=False)[:500]}")
        return None

    except Exception as e:
        print(f"[ERROR] images/generations 异常: {e}")
        traceback.print_exc()
        return None


def call_tuzi_chat_completions_for_image(
    prompt: str,
    reference_image_path = None,  # 可以是单个路径(str)或多个路径(list)
    model: str = "gpt-image-2",
    base_url: str = "https://api.tu-zi.com",
    api_key: str = "",
    proxy_url: str = "",
    timeout: float = 360,
    temperature: float = 0.7,
    max_tokens: int = 100000,
    room_id: Optional[str] = None
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
        room_id: 房间ID，用于决定差异化重试策略

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

        # ========== 图片生成重试策略配置 ==========
        # 第一优先级：gpt-image-2（更适合汉字与排版）
        # 第二优先级：当前 tuZi Gemini async 方案
        # 注：gemini-3-pro-image-preview-async 即 nano-banana-pro 的异步版本
        SUI_ROOM_ID = "25788785"
        primary_model = model or "gpt-image-2"
        fallback_async_model = "gemini-3-pro-image-preview-async"
        if str(room_id) == SUI_ROOM_ID:
            # 岁己专属：多次 GPT 生图，最后回退 async Gemini
            print(f"[INFO] 房间 {room_id} (岁己) 使用专属策略：{primary_model} x3 -> async {fallback_async_model}")
            retry_strategies = [
                {"type": "sync", "model": primary_model},
                {"type": "sync", "model": primary_model},
                {"type": "sync", "model": primary_model},
                {"type": "async", "model": fallback_async_model},
            ]
        else:
            # 其他主播：GPT 生图多次重试
            print(f"[INFO] 房间 {room_id} 使用轻量策略：{primary_model} x3")
            retry_strategies = [
                {"type": "sync", "model": primary_model},
                {"type": "sync", "model": primary_model},
                {"type": "sync", "model": primary_model},
                # {"type": "async", "model": fallback_async_model},  # 2026-04-23: gemini-3-pro-image-preview-async 临时涨价，注释掉
            ]
            # --- 旧的多模型降级策略（已停用，保留备查） ---
            # retry_strategies = [
            #     {"type": "async", "model": "gemini-3-pro-image-preview-async"},  # 异步 nano-banana-pro（失败不扣费）
            #     {"type": "sync",  "model": "gpt-image-1.5"},                     # GPT Image 1.5
            #     {"type": "sync",  "model": "gemini-2.5-flash-image-vip"},        # Gemini 2.5 Flash Image VIP
            #     {"type": "sync",  "model": model},                               # config 中配置的当前模型
            #     {"type": "sync",  "model": "gemini-3-pro-image-preview/nano-banana-2"},  # nano-banana（贵）
            # ]

        strategy_list = [f"{s['type']}:{s['model']}" for s in retry_strategies]
        print(f"[INFO] 图片生成重试策略: {strategy_list}")
        # ==========================================

        response = None
        for attempt, strategy in enumerate(retry_strategies):
            try:
                strategy_type = strategy["type"]
                current_model = strategy["model"]
                
                # 根据当前模型动态替换 prompt 中的汉字指令占位符
                current_prompt = prompt.replace("{chinese_instruction}", get_chinese_instruction(current_model))
                
                print(f"[WAIT] 正在生成图像... (尝试 {attempt + 1}/{len(retry_strategies)}, 类型: {strategy_type}, 模型: {current_model}, 超时: {timeout}s)")

                # 异步策略：调用 Gemini 异步 API
                if strategy_type == "async" and call_tuzi_gemini_async is not None:
                    print("[INFO] 使用 Gemini 异步 API...")
                    try:
                        # 创建任务的 timeout 固定 60s（仅提交请求），
                        # max_poll_time 控制轮询最大等待时长，设为 1400s（约23分钟），
                        # 足以覆盖实测最长 864s 的生成耗时并留有余量
                        ASYNC_CREATE_TIMEOUT = 60
                        ASYNC_MAX_POLL_TIME = 1400
                        gemini_result = call_tuzi_gemini_async(
                            prompt=current_prompt,  # 使用替换后的 prompt
                            reference_image_paths=reference_images if reference_images else [],
                            model=current_model,
                            base_url=base_url,
                            api_key=api_key,
                            proxy_url=proxy_url,
                            timeout=ASYNC_CREATE_TIMEOUT,
                            size="9:16",
                            max_poll_time=ASYNC_MAX_POLL_TIME
                        )
                        
                        if gemini_result:
                            print("[OK] Gemini 异步 API 生成成功！")
                            return gemini_result
                        else:
                            print("[WARNING] Gemini 异步 API 失败，继续尝试下一个策略...")
                    except Exception as gemini_err:
                        print(f"[WARNING] Gemini 异步 API 调用异常: {gemini_err}")
                    
                    # 异步失败后继续下一个策略
                    if attempt < len(retry_strategies) - 1:
                        print("[RETRY] 2秒后尝试下一个策略...")
                        time.sleep(2)
                    continue
                
                # 同步策略：调用标准 chat/completions API
                if strategy_type == "sync":
                    # gpt-image-2 专用：优先使用 /v1/images/generations 接口
                    if current_model in ("gpt-image-2", "gpt-image-1.5", "gpt-image-1"):
                        print(f"[INFO] 使用 /v1/images/generations 专用接口调用 {current_model}")
                        img_gen_result = call_tuzi_images_generations(
                            prompt=current_prompt,
                            reference_image_path=reference_images if reference_images else None,
                            model=current_model,
                            base_url=base_url,
                            api_key=api_key,
                            proxy_url=proxy_url,
                            timeout=timeout,
                            size="1:1",
                            n=1,
                            response_format="b64_json",
                            quality="high",
                            output_format="png"
                        )
                        if img_gen_result:
                            return img_gen_result
                        print(f"[WARNING] images/generations 失败，回退到 chat/completions 格式")

                    # 回退：使用 /v1/chat/completions 格式（兼容旧模型）
                    # 重新构建消息列表，使用当前模型对应的 prompt
                    current_messages = []
                    
                    # 如果有参考图，添加到消息中
                    if reference_images:
                        content_parts = [{"type": "text", "text": "请参考以下图片的风格和角色形象："}]
                        for idx, img_path in enumerate(reference_images, 1):
                            image_base64 = encode_image_to_base64(img_path, with_data_uri=True)
                            content_parts.append({
                                "type": "image_url", 
                                "image_url": {"url": image_base64}
                            })
                        current_messages.append({
                            "role": "user",
                            "content": content_parts
                        })
                    
                    # 添加图像生成提示词（使用替换后的 prompt）
                    current_messages.append({
                        "role": "user",
                        "content": current_prompt
                    })
                    
                    # 构建请求体 - /v1/chat/completions 格式
                    payload = {
                        "model": current_model,
                        "messages": current_messages,
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

                    direct_data_result = try_extract_image_from_data_items(result.get("data"), proxies)
                    if direct_data_result:
                        return direct_data_result

                    # 处理 /v1/chat/completions 响应格式
                    if "choices" in result and len(result["choices"]) > 0:
                        choice = result["choices"][0]
                        message = choice.get("message", {})
                        content = message.get("content", "")

                        extracted_from_content = try_extract_image_from_message_content(content, proxies, timeout)
                        if extracted_from_content:
                            return extracted_from_content

                        # 检查是否有工具调用（某些API可能通过工具返回图像）
                        tool_calls = message.get("tool_calls", [])
                        if tool_calls:
                            for tool_call in tool_calls:
                                if tool_call.get("type") == "function":
                                    function_args = tool_call.get("function", {}).get("arguments", "{}")
                                    try:
                                        args_json = json.loads(function_args)
                                        if "image_url" in args_json:
                                            direct_tool_result = download_image_to_temp(args_json["image_url"], proxies)
                                            if direct_tool_result:
                                                return direct_tool_result
                                        data_tool_result = try_extract_image_from_data_items(args_json.get("data"), proxies)
                                        if data_tool_result:
                                            return data_tool_result
                                    except Exception as json_error:
                                        print(f"[WARNING] 解析工具调用参数失败: {json_error}")

                    # 如果到这里还没返回，说明响应格式不符合预期
                    print(f"[ERROR] 无法从响应中提取图像数据")
                    print(f"[DEBUG] 完整响应: {json.dumps(result, ensure_ascii=False, indent=2)[:1000]}")
                else:
                    print(f"[WARNING] tu-zi.com API调用失败 (尝试 {attempt + 1}/{len(retry_strategies)}): HTTP {response.status_code} elapsed: {response.elapsed.total_seconds()}s")
                
                # 如果没成功且还有剩余策略，等待一下再试
                if attempt < len(retry_strategies) - 1:
                    print("[RETRY] 2秒后尝试下一个策略...")
                    time.sleep(2)


            except Exception as req_err:
                print(f"[ERROR] 请求异常 (尝试 {attempt + 1}/{len(retry_strategies)}): {req_err}")
                if attempt < len(retry_strategies) - 1:
                    print("[RETRY] 2秒后尝试下一个策略...")
                    time.sleep(2)
        
        return None

    except Exception as e:
        print(f"[ERROR] tu-zi.com图像生成失败: {e}")
        traceback.print_exc()
        return None
