#!/usr/bin/env python3
"""
tuZi Gemini 异步图像生成 API 封装模块
用于调用 gemini-3-pro-image-preview-async 异步任务接口
失败不扣费，适合作为 nano-banana 和 gpt-image-1.5 之间的备选方案
"""

import os
import requests
import json
import time
from typing import Optional, Dict, Any, List
import traceback


def call_tuzi_gemini_async(
    prompt: str,
    reference_image_paths: Optional[List[str]] = None,
    model: str = "gemini-3-pro-image-preview-async",
    base_url: str = "https://api.tu-zi.com",
    api_key: str = "",
    proxy_url: str = "",
    timeout: float = 360,
    size: str = "9:16",
    max_poll_time: float = 300
) -> Optional[str]:
    """
    调用tuZi的 Gemini 异步图像生成 API
    
    Args:
        prompt: 图像生成提示词
        reference_image_paths: 参考图片路径列表（可选，支持多图）
        model: 模型名称，可选值：
            - gemini-3-pro-image-preview-async (1k 异步)
            - gemini-3-pro-image-preview-2k-async (2k 异步)
            - gemini-3-pro-image-preview-4k-async (4k 异步)
        base_url: API基础URL
        api_key: API密钥
        proxy_url: 代理URL
        timeout: 请求超时时间（秒）
        size: 图像尺寸比例，可选值：1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9
        max_poll_time: 最大轮询等待时间（秒）
        
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

        # 构建API请求URL
        create_api_url = f"{base_url}/v1/videos"
        
        headers = {
            "Authorization": f"Bearer {api_key}"
        }

        # 构建 multipart/form-data 请求
        # 注意：对于多个文件，需要使用列表格式
        data = {
            'model': model,
            'prompt': prompt,
            'size': size
        }
        
        # 准备文件列表（支持多图）
        files_to_upload = []
        if reference_image_paths:
            for img_path in reference_image_paths:
                if os.path.exists(img_path):
                    # 读取文件内容
                    with open(img_path, 'rb') as f:
                        image_data = f.read()
                    # 添加到文件列表，使用相同的字段名 'input_reference'
                    files_to_upload.append(
                        ('input_reference', (os.path.basename(img_path), image_data, 'image/jpeg'))
                    )
                    print(f"[INFO] 已添加参考图: {os.path.basename(img_path)}")
                else:
                    print(f"[WARNING] 参考图不存在: {img_path}")

        print(f"[GEMINI_ASYNC] 创建异步图像生成任务...")
        print(f"[DEBUG] 模型: {model}, 尺寸: {size}, 提示词长度: {len(prompt)}, 参考图数量: {len(files_to_upload)}")
        
        # 第一步：创建任务
        create_response = requests.post(
            create_api_url,
            headers=headers,
            data=data,
            files=files_to_upload if files_to_upload else None,
            timeout=timeout,
            proxies=proxies
        )

        if create_response.status_code != 200:
            print(f"[ERROR] 创建任务失败: HTTP {create_response.status_code}")
            print(f"[DEBUG] 响应内容: {create_response.text[:500]}")
            return None

        create_result = create_response.json()
        print(f"[DEBUG] 创建任务响应: {json.dumps(create_result, ensure_ascii=False, indent=2)}")

        # 提取任务ID
        task_id = create_result.get("id")
        if not task_id:
            print(f"[ERROR] 响应中未找到任务ID")
            return None

        task_status = create_result.get("status", "unknown")
        print(f"[OK] 任务创建成功，ID: {task_id}, 初始状态: {task_status}")

        # 第二步：轮询任务状态
        query_api_url = f"{base_url}/v1/videos/{task_id}"
        start_time = time.time()
        poll_interval = 3  # 每3秒查询一次
        
        while time.time() - start_time < max_poll_time:
            try:
                print(f"[WAIT] 查询任务状态... (已等待 {int(time.time() - start_time)}s)")
                
                query_response = requests.get(
                    query_api_url,
                    headers=headers,
                    timeout=30,
                    proxies=proxies
                )

                if query_response.status_code != 200:
                    print(f"[WARNING] 查询任务状态失败: HTTP {query_response.status_code}")
                    time.sleep(poll_interval)
                    continue

                query_result = query_response.json()
                current_status = query_result.get("status", "unknown")
                progress = query_result.get("progress", 0)
                
                print(f"[INFO] 任务状态: {current_status}, 进度: {progress}%")

                # 检查任务是否完成
                if current_status == "completed" or current_status == "succeeded":
                    print(f"[OK] 任务完成！")
                    
                    # 尝试从响应中提取图像URL
                    # 可能的字段：video_url, url, urls, output, outputs, result, data 等
                    image_url = None
                    
                    # 尝试多种可能的字段
                    # 优先检查 video_url（Gemini 异步 API 实际使用的字段）
                    if "video_url" in query_result:
                        image_url = query_result["video_url"]
                    elif "image_url" in query_result:
                        image_url = query_result["image_url"]
                    elif "url" in query_result:
                        image_url = query_result["url"]
                    elif "urls" in query_result and isinstance(query_result["urls"], list) and len(query_result["urls"]) > 0:
                        image_url = query_result["urls"][0]
                    elif "output" in query_result:
                        image_url = query_result["output"]
                    elif "outputs" in query_result and isinstance(query_result["outputs"], list) and len(query_result["outputs"]) > 0:
                        image_url = query_result["outputs"][0]
                    elif "result" in query_result:
                        result_data = query_result["result"]
                        if isinstance(result_data, str):
                            image_url = result_data
                        elif isinstance(result_data, dict) and "url" in result_data:
                            image_url = result_data["url"]
                    elif "data" in query_result:
                        data = query_result["data"]
                        if isinstance(data, str):
                            image_url = data
                        elif isinstance(data, dict) and "url" in data:
                            image_url = data["url"]
                        elif isinstance(data, list) and len(data) > 0:
                            if isinstance(data[0], str):
                                image_url = data[0]
                            elif isinstance(data[0], dict) and "url" in data[0]:
                                image_url = data[0]["url"]

                    if not image_url:
                        print(f"[ERROR] 任务完成但未找到图像URL")
                        print(f"[DEBUG] 完整响应: {json.dumps(query_result, ensure_ascii=False, indent=2)}")
                        return None

                    print(f"[DOWNLOAD] 下载生成的图像: {image_url}")
                    
                    # 下载图像
                    try:
                        image_response = requests.get(image_url, timeout=60, proxies=proxies)
                        
                        if image_response.status_code == 200:
                            import tempfile
                            import uuid
                            
                            temp_dir = tempfile.gettempdir()
                            temp_file = os.path.join(temp_dir, f"comic_gemini_async_{uuid.uuid4().hex[:8]}.png")
                            
                            with open(temp_file, 'wb') as f:
                                f.write(image_response.content)
                            
                            print(f"[OK] Gemini异步图像生成成功")
                            print(f"[SAVE] 图像已保存到临时文件: {temp_file}")
                            return temp_file
                        else:
                            print(f"[ERROR] 图像下载失败: HTTP {image_response.status_code}")
                            return None
                            
                    except Exception as download_error:
                        print(f"[ERROR] 图像下载异常: {download_error}")
                        traceback.print_exc()
                        return None

                # 检查任务是否失败
                elif current_status == "failed" or current_status == "error":
                    error_msg = query_result.get("error", query_result.get("message", "未知错误"))
                    print(f"[ERROR] 任务失败: {error_msg}")
                    print(f"[DEBUG] 完整响应: {json.dumps(query_result, ensure_ascii=False, indent=2)}")
                    return None

                # 任务仍在进行中
                elif current_status in ["queued", "processing", "pending", "running", "in_progress"]:
                    print(f"[WAIT] 任务进行中，{poll_interval}秒后再次查询...")
                    time.sleep(poll_interval)
                    continue

                else:
                    # 未知状态
                    print(f"[WARNING] 未知任务状态: {current_status}")
                    print(f"[DEBUG] 完整响应: {json.dumps(query_result, ensure_ascii=False, indent=2)}")
                    time.sleep(poll_interval)
                    continue

            except Exception as poll_error:
                print(f"[WARNING] 轮询异常: {poll_error}")
                time.sleep(poll_interval)
                continue

        # 轮询超时
        print(f"[ERROR] 任务轮询超时 ({max_poll_time}s)")
        return None

    except Exception as e:
        print(f"[ERROR] Gemini异步图像生成失败: {e}")
        traceback.print_exc()
        return None


def test_gemini_async():
    """测试函数"""
    import sys
    
    if len(sys.argv) < 2:
        print("用法: python tuzi_gemini_async.py <提示词> [参考图路径1] [参考图路径2] ...")
        sys.exit(1)
    
    prompt = sys.argv[1]
    reference_images = sys.argv[2:] if len(sys.argv) > 2 else None
    
    # 从环境变量或配置文件读取API密钥
    api_key = os.environ.get("TUZI_API_KEY", "")
    if not api_key:
        print("[ERROR] 请设置环境变量 TUZI_API_KEY")
        sys.exit(1)
    
    print(f"提示词: {prompt}")
    if reference_images:
        print(f"参考图: {reference_images}")
    
    result = call_tuzi_gemini_async(
        prompt=prompt,
        reference_image_paths=reference_images,
        api_key=api_key
    )
    
    if result:
        print(f"\n✅ 成功！图像保存在: {result}")
    else:
        print(f"\n❌ 失败")
        sys.exit(1)


if __name__ == "__main__":
    test_gemini_async()
