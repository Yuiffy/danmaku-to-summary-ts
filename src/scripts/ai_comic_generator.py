#!/usr/bin/env python3
"""
AI漫画生成模块
使用Hugging Face的AI Comic Factory生成直播总结漫画
"""

import os
import sys
import json
import time
import base64
import requests
from pathlib import Path
from typing import Optional, Dict, Any
import traceback

# 配置路径
CONFIG_PATH = os.path.join(os.path.dirname(__file__), 'config.json')

def load_config() -> Dict[str, Any]:
    """加载配置文件（包括config.json和config.secrets.json）"""
    default_config = {
        "aiServices": {
            "huggingFace": {
                "enabled": True,
                "apiToken": "",
                "comicFactoryModel": "jbilcke-hf/ai-comic-factory",
                "proxy": ""
            }
        },
        "roomSettings": {
            "26966466": {
                "referenceImage": "reference_images/26966466.jpg",
                "enableComicGeneration": True
            }
        },
        "timeouts": {
            "aiApiTimeout": 120000
        }
    }
    
    try:
        merged = default_config.copy()
        
        # 加载主配置文件
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                user_config = json.load(f)
            
            # 深度合并配置
            import copy
            merged = copy.deepcopy(default_config)
            
            # 合并aiServices
            if "aiServices" in user_config:
                if "huggingFace" in user_config["aiServices"]:
                    merged["aiServices"]["huggingFace"].update(user_config["aiServices"]["huggingFace"])
            
            # 合并roomSettings
            if "roomSettings" in user_config:
                merged["roomSettings"].update(user_config["roomSettings"])
            
            # 合并timeouts
            if "timeouts" in user_config:
                merged["timeouts"].update(user_config["timeouts"])
        
        # 加载密钥文件
        secrets_path = os.path.join(os.path.dirname(__file__), 'config.secrets.json')
        if os.path.exists(secrets_path):
            with open(secrets_path, 'r', encoding='utf-8') as f:
                secrets_config = json.load(f)
            
            # 合并密钥配置
            if "aiServices" in secrets_config:
                if "huggingFace" in secrets_config["aiServices"]:
                    # 只合并apiToken，保留其他配置
                    hf_secrets = secrets_config["aiServices"]["huggingFace"]
                    if "apiToken" in hf_secrets:
                        merged["aiServices"]["huggingFace"]["apiToken"] = hf_secrets["apiToken"]
        
        return merged
        
    except Exception as e:
        print(f"[ERROR] 加载配置文件失败: {e}")
        import traceback
        traceback.print_exc()
    
    return default_config

def is_huggingface_configured() -> bool:
    """检查Hugging Face配置是否有效"""
    config = load_config()
    hf_config = config["aiServices"]["huggingFace"]
    return hf_config["enabled"] and hf_config["apiToken"] and hf_config["apiToken"].strip() != ""

def get_room_reference_image(room_id: str) -> Optional[str]:
    """获取房间的参考图片路径"""
    config = load_config()
    
    # 首先检查roomSettings中的配置
    room_str = str(room_id)
    if room_str in config["roomSettings"]:
        ref_image = config["roomSettings"][room_str].get("referenceImage", "")
        if ref_image and os.path.exists(ref_image):
            return ref_image
        
        # 如果配置了但文件不存在，尝试在reference_images目录中查找
        ref_images_dir = os.path.join(os.path.dirname(__file__), "reference_images")
        if os.path.exists(ref_images_dir):
            possible_files = [
                os.path.join(ref_images_dir, f"{room_id}.jpg"),
                os.path.join(ref_images_dir, f"{room_id}.jpeg"),
                os.path.join(ref_images_dir, f"{room_id}.png"),
                os.path.join(ref_images_dir, f"{room_id}.webp")
            ]
            for file_path in possible_files:
                if os.path.exists(file_path):
                    return file_path
    
    # 如果没有找到房间特定的图片，使用默认图片
    default_image = config.get("aiServices", {}).get("defaultReferenceImage", "")
    if default_image and os.path.exists(default_image):
        print(f"[INFO]  使用默认参考图片: {os.path.basename(default_image)}")
        return default_image
    
    # 检查默认图片文件是否存在
    ref_images_dir = os.path.join(os.path.dirname(__file__), "reference_images")
    if os.path.exists(ref_images_dir):
        default_files = [
            os.path.join(ref_images_dir, "default.jpg"),
            os.path.join(ref_images_dir, "default.jpeg"),
            os.path.join(ref_images_dir, "default.png"),
            os.path.join(ref_images_dir, "default.webp"),
            os.path.join(ref_images_dir, "岁己小红帽立绘.png")  # 特定文件名
        ]
        for file_path in default_files:
            if os.path.exists(file_path):
                print(f"[INFO]  找到默认图片: {os.path.basename(file_path)}")
                return file_path
    
    return None

def read_highlight_file(highlight_path: str) -> str:
    """读取AI_HIGHLIGHT.txt内容"""
    try:
        with open(highlight_path, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        print(f"[ERROR] 读取AI_HIGHLIGHT文件失败: {e}")
        raise

def extract_room_id_from_filename(filename: str) -> Optional[str]:
    """从文件名中提取房间ID"""
    # DDTV文件名格式: 26966466_20240101_120000_AI_HIGHLIGHT.txt
    import re
    match = re.match(r'^(\d+)_', filename)
    return match.group(1) if match else None

def optimize_prompt_with_gemini(highlight_content: str, reference_image_path: Optional[str] = None) -> str:
    """使用Gemini优化漫画生成提示词"""
    print("[GEMINI] 使用Gemini优化漫画提示词...")
    
    try:
        # 导入Google Generative AI
        import google.generativeai as genai
        
        # 加载配置
        config = load_config()
        
        # 获取Gemini配置
        gemini_config = config.get('aiServices', {}).get('gemini', {})
        gemini_api_key = gemini_config.get('apiKey', '')
        
        if not gemini_api_key:
            print("[WARNING]  Gemini API密钥未配置，使用原始提示词")
            return build_comic_prompt(highlight_content, reference_image_path)
        
        # 配置Gemini
        genai.configure(api_key=gemini_api_key)
        
        # 设置代理
        proxy_url = gemini_config.get('proxy', '')
        if proxy_url:
            import os
            os.environ['http_proxy'] = proxy_url
            os.environ['https_proxy'] = proxy_url
        
        # 创建模型
        model_name = gemini_config.get('model', 'gemini-2.0-flash-exp')
        model = genai.GenerativeModel(model_name)
        
        # 构建优化提示词
        optimization_prompt = f"""你是一个专业的漫画脚本作家和AI绘画提示词专家。

任务：将直播内容转化为适合AI图像生成的漫画脚本提示词。

直播内容：
{highlight_content[:1500]}  # 限制长度

要求：
1. 生成适合Stable Diffusion/DALL-E/Midjourney等AI绘画模型的英文提示词
2. 提示词要详细描述场景、角色、动作、表情、构图、风格
3. 如果是虚拟主播直播，注意角色特征（如：岁己SUI是白发红瞳女生，饼干岁是小饼干状生物）
4. 风格要求：日本漫画风格，多分镜（5-8个场景），每个场景有简短文字说明
5. 画面要生动、有趣、有故事性
6. 输出格式：纯英文的详细提示词，适合直接输入给AI绘画模型

请生成优化的AI绘画提示词："""
        
        # 调用Gemini
        response = model.generate_content(optimization_prompt)
        
        if response and response.text:
            optimized_prompt = response.text.strip()
            print("[OK] Gemini提示词优化完成")
            print(f"优化后提示词长度: {len(optimized_prompt)} 字符")
            return optimized_prompt
        else:
            print("[WARNING]  Gemini返回空结果，使用原始提示词")
            return build_comic_prompt(highlight_content, reference_image_path)
            
    except ImportError:
        print("[WARNING]  google-generativeai库未安装，使用原始提示词")
        print("   请安装: pip install google-generativeai")
    except Exception as e:
        print(f"[ERROR]  Gemini优化失败: {e}")
        import traceback
        traceback.print_exc()
    
    # 失败时返回原始提示词
    return build_comic_prompt(highlight_content, reference_image_path)

def build_comic_prompt(highlight_content: str, reference_image_path: Optional[str] = None) -> str:
    """构建漫画生成提示词（原始版本）"""
    base_prompt = f"""<job>你作为虚拟主播二创画师大手子，根据直播内容，绘制直播总结插画。</job>

<character>注意一定要还原附件image_0图片中的角色形象，岁己SUI（白发红瞳女生），饼干岁（有细细四肢的小小的饼干状生物）</character>

<style>多个剪贴画风格或者少年漫多个分镜（5~8个吧），每个是一个片段场景，画图+文字台词or简介，文字要短。要画得精致，岁己要美丽动人，饼干岁要可爱。</style>

<note>一定要按照给你的参考图还原形象，而不是自己乱画一个动漫角色</note>

<language>画面内的文字要用中文</language>

下面是岁己一场直播的asr+弹幕记录TXT，请根据这个内容生成漫画：
{highlight_content}"""
    
    return base_prompt

def encode_image_to_base64(image_path: str) -> str:
    """将图片编码为base64"""
    try:
        with open(image_path, "rb") as image_file:
            encoded_string = base64.b64encode(image_file.read()).decode('utf-8')
        return encoded_string
    except Exception as e:
        print(f"[ERROR] 图片编码失败: {e}")
        raise

def try_simpler_model(prompt: str, hf_config: Dict[str, Any], proxies: Dict[str, str]) -> Optional[str]:
    """尝试使用更简单的模型生成图像"""
    try:
        # 尝试使用更小、更快的模型
        simpler_models = [
            "runwayml/stable-diffusion-v1-5",
            "CompVis/stable-diffusion-v1-4",
            "prompthero/openjourney"
        ]
        
        for model_name in simpler_models:
            print(f"[RETRY] 尝试模型: {model_name}")
            
            router_url = "https://router.huggingface.co/hf-inference/models"
            headers = {
                "Authorization": f"Bearer {hf_config['apiToken']}",
                "Content-Type": "application/json"
            }
            
            simple_prompt = f"Anime comic style: {prompt[:100]}"
            
            payload = {
                "inputs": simple_prompt,
                "parameters": {
                    "num_inference_steps": 15,
                    "guidance_scale": 7.0,
                    "width": 512,
                    "height": 512
                }
            }
            
            api_url = f"{router_url}/{model_name}"
            response = requests.post(api_url, headers=headers, json=payload, timeout=120, proxies=proxies)
            
            if response.status_code == 200:
                print(f"[OK] 图像生成成功 (模型: {model_name})")
                
                import tempfile
                import uuid
                temp_dir = tempfile.gettempdir()
                temp_file = os.path.join(temp_dir, f"comic_{uuid.uuid4().hex[:8]}.png")
                
                with open(temp_file, 'wb') as f:
                    f.write(response.content)
                
                print(f"[SAVE] 图像已保存: {temp_file}")
                return temp_file
            elif response.status_code == 503:
                print(f"[INFO]  模型 {model_name} 正在加载，跳过")
                continue
            else:
                print(f"[WARNING]  模型 {model_name} 失败: {response.status_code}")
                continue
        
        print("[ERROR] 所有模型尝试都失败")
        return None
        
    except Exception as e:
        print(f"[ERROR] 尝试简单模型失败: {e}")
        return None

def call_huggingface_comic_factory(prompt: str, reference_image_path: Optional[str] = None) -> Optional[str]:
    """
    调用Hugging Face AI Comic Factory API
    使用更可靠的备用方案，因为gradio_client可能有连接问题
    """
    config = load_config()
    hf_config = config["aiServices"]["huggingFace"]
    
    if not is_huggingface_configured():
        raise ValueError("Hugging Face API未配置，请检查config.json中的apiToken")
    
    print("[ART] 调用Hugging Face AI Comic Factory生成漫画...")
    
    # 获取代理配置
    proxy_url = hf_config.get("proxy", "")
    
    # 设置代理
    proxies = {}
    if proxy_url:
        proxies = {
            "http": proxy_url,
            "https": proxy_url
        }
        print(f"[PROXY] 使用代理: {proxy_url}")
    
    try:
        # 方案1：尝试使用gradio_client（如果可用）
        try:
            from gradio_client import Client
            
            # 设置环境变量
            if proxy_url:
                import os
                os.environ["HTTP_PROXY"] = proxy_url
                os.environ["HTTPS_PROXY"] = proxy_url
                os.environ["http_proxy"] = proxy_url
                os.environ["https_proxy"] = proxy_url
            
            print("[GRADIO] 尝试使用gradio_client连接...")
            client = Client(hf_config["comicFactoryModel"], verbose=False)
            
            # 准备参数
            params = {
                "prompt": prompt,
                "style": "Japanese Manga",  # 漫画风格
                "layout": "Neutral",        # 布局风格
            }
            
            print("[WAIT] 正在生成漫画，这可能需要几分钟...")
            result = client.predict(**params)
            
            # 处理返回结果
            if result and isinstance(result, (str, list)):
                print("[OK] 漫画生成成功 (gradio_client)")
                return str(result[0] if isinstance(result, list) else result)
            else:
                print("[WARNING]  生成结果格式异常")
                # 继续尝试备用方案
                raise ValueError("gradio_client返回结果格式异常")
                
        except Exception as gradio_error:
            print(f"[WARNING]  gradio_client失败: {gradio_error}")
            print("   切换到备用方案...")
            
    except ImportError:
        print("[WARNING]  gradio_client未安装，使用备用方案")
    
    # 方案2：使用Hugging Face Router API（备用方案）
    print("[BACKUP] 使用Hugging Face Router API备用方案...")
    
    try:
        # 使用新的router API端点
        router_url = "https://router.huggingface.co/hf-inference/models"
        
        # 使用一个稳定的文本到图像模型
        model_name = "stabilityai/stable-diffusion-xl-base-1.0"
        
        # 构建请求
        headers = {
            "Authorization": f"Bearer {hf_config['apiToken']}",
            "Content-Type": "application/json"
        }
        
        # 构建更简单的提示词
        simple_prompt = f"Anime style comic panel, cute character, colorful: {prompt[:150]}"
        
        payload = {
            "inputs": simple_prompt,
            "parameters": {
                "num_inference_steps": 20,
                "guidance_scale": 7.5,
                "width": 512,
                "height": 512
            }
        }
        
        # 完整的API URL
        api_url = f"{router_url}/{model_name}"
        
        print(f"[WAIT] 通过Router API生成图像 (模型: {model_name})...")
        response = requests.post(api_url, headers=headers, json=payload, timeout=180, proxies=proxies)
        
        if response.status_code == 200:
            print("[OK] 图像生成成功 (Router API)")
            
            # 保存图像
            import tempfile
            import uuid
            
            # 创建临时文件
            temp_dir = tempfile.gettempdir()
            temp_file = os.path.join(temp_dir, f"comic_{uuid.uuid4().hex[:8]}.png")
            
            with open(temp_file, 'wb') as f:
                f.write(response.content)
            
            print(f"[SAVE] 图像已保存到临时文件: {temp_file}")
            return temp_file
            
        elif response.status_code == 503:
            print("[INFO]  模型正在加载，请稍后重试")
            print("   响应: " + response.text[:200])
            return None
        else:
            print(f"[ERROR] API调用失败: {response.status_code}")
            print(f"   响应头: {dict(response.headers)}")
            print(f"   响应内容: {response.text[:500]}")
            
            # 尝试使用更简单的模型
            print("[RETRY] 尝试使用更简单的模型...")
            return try_simpler_model(prompt, hf_config, proxies)
            
    except Exception as e:
        print(f"[ERROR] 备用方案也失败: {e}")
        traceback.print_exc()
        return None

def save_comic_result(output_path: str, comic_data: Any) -> str:
    """保存漫画结果"""
    try:
        # 如果comic_data是文件路径，复制文件
        if isinstance(comic_data, str) and os.path.exists(comic_data):
            print(f"[COPY] 复制漫画图片: {os.path.basename(comic_data)}")
            import shutil
            shutil.copy2(comic_data, output_path)
            print(f"[OK] 漫画图片已保存: {os.path.basename(output_path)}")
            return output_path
        
        # 如果comic_data是URL，下载图片
        elif isinstance(comic_data, str) and comic_data.startswith(('http://', 'https://')):
            print(f"[DOWNLOAD] 下载漫画图片: {comic_data}")
            response = requests.get(comic_data, timeout=60)
            if response.status_code == 200:
                with open(output_path, 'wb') as f:
                    f.write(response.content)
                print(f"[OK] 漫画图片已保存: {os.path.basename(output_path)}")
                return output_path
            else:
                raise ValueError(f"下载失败: {response.status_code}")
        
        # 如果comic_data是base64编码的图片
        elif isinstance(comic_data, str) and len(comic_data) > 100 and 'data:image' in comic_data:
            # 提取base64数据
            import re
            match = re.search(r'base64,(.+)', comic_data)
            if match:
                image_data = base64.b64decode(match.group(1))
                with open(output_path, 'wb') as f:
                    f.write(image_data)
                print(f"[OK] 漫画图片已保存: {os.path.basename(output_path)}")
                return output_path
        
        # 其他情况，直接保存为文本（可能是错误信息或文本结果）
        else:
            with open(output_path, 'w', encoding='utf-8') as f:
                f.write(str(comic_data))
            print(f"[OK] 漫画结果已保存为文本: {os.path.basename(output_path)}")
            return output_path
            
    except Exception as e:
        print(f"[ERROR] 保存漫画结果失败: {e}")
        raise

def generate_comic_from_highlight(highlight_path: str) -> Optional[str]:
    """从AI_HIGHLIGHT文件生成漫画"""
    config = load_config()
    
    if not config["aiServices"]["huggingFace"]["enabled"]:
        print("[INFO]  AI漫画生成功能已禁用")
        return None
    
    if not is_huggingface_configured():
        print("[WARNING]  Hugging Face API未配置，跳过漫画生成")
        return None
    
    print(f"[FILE] 处理AI_HIGHLIGHT文件: {os.path.basename(highlight_path)}")
    
    try:
        # 检查输入文件
        if not os.path.exists(highlight_path):
            raise FileNotFoundError(f"AI_HIGHLIGHT文件不存在: {highlight_path}")
        
        # 提取房间ID
        filename = os.path.basename(highlight_path)
        room_id = extract_room_id_from_filename(filename)
        
        if not room_id:
            print("[WARNING]  无法从文件名提取房间ID")
            room_id = "unknown"
        
        print(f"[ROOM] 房间ID: {room_id}")
        
        # 获取参考图片
        reference_image_path = get_room_reference_image(room_id)
        if reference_image_path:
            print(f"[IMAGE]  找到参考图片: {os.path.basename(reference_image_path)}")
        else:
            print("[WARNING]  未找到参考图片，将仅使用提示词生成")
        
        # 检查房间是否启用漫画生成
        room_str = str(room_id)
        if room_str in config["roomSettings"]:
            if not config["roomSettings"][room_str].get("enableComicGeneration", True):
                print(f"[INFO]  房间 {room_id} 的漫画生成功能已禁用")
                return None
        
        # 读取内容
        highlight_content = read_highlight_file(highlight_path)
        print(f"[BOOK] 读取内容完成 ({len(highlight_content)} 字符)")
        
        # 构建提示词（使用Gemini优化）
        prompt = optimize_prompt_with_gemini(highlight_content, reference_image_path)
        
        # 调用API生成漫画
        comic_result = call_huggingface_comic_factory(prompt, reference_image_path)
        
        if not comic_result:
            print("[ERROR] 漫画生成失败，无返回结果")
            return None
        
        # 确定输出路径
        dir_name = os.path.dirname(highlight_path)
        base_name = os.path.basename(highlight_path).replace('_AI_HIGHLIGHT.txt', '')
        output_path = os.path.join(dir_name, f"{base_name}_COMIC_FACTORY.png")
        
        # 保存结果
        return save_comic_result(output_path, comic_result)
        
    except Exception as e:
        print(f"[ERROR] 生成漫画失败: {e}")
        traceback.print_exc()
        return None

def main():
    """主函数"""
    if len(sys.argv) < 2:
        print("用法: python ai_comic_generator.py <AI_HIGHLIGHT.txt路径>")
        print("或:    python ai_comic_generator.py --batch <目录路径>")
        sys.exit(1)
    
    try:
        if sys.argv[1] == "--batch" and len(sys.argv) > 2:
            directory = sys.argv[2]
            print(f"[SEARCH] 批量处理目录: {directory}")
            
            if not os.path.exists(directory):
                print(f"[ERROR] 目录不存在: {directory}")
                sys.exit(1)
            
            highlight_files = []
            for root, dirs, files in os.walk(directory):
                for file in files:
                    if "_AI_HIGHLIGHT.txt" in file:
                        highlight_files.append(os.path.join(root, file))
            
            print(f"找到 {len(highlight_files)} 个AI_HIGHLIGHT文件")
            
            success_count = 0
            for i, file_path in enumerate(highlight_files, 1):
                print(f"\n--- [{i}/{len(highlight_files)}] 处理: {os.path.basename(file_path)} ---")
                try:
                    result = generate_comic_from_highlight(file_path)
                    if result:
                        success_count += 1
                        print(f"[OK] 成功生成: {os.path.basename(result)}")
                    else:
                        print("[ERROR] 生成失败")
                except Exception as e:
                    print(f"[ERROR] 处理失败: {e}")
            
            print(f"\n[CHART] 批量处理完成:")
            print(f"   [OK] 成功: {success_count} 个")
            print(f"   [ERROR] 失败: {len(highlight_files) - success_count} 个")
            
        else:
            highlight_path = sys.argv[1]
            result = generate_comic_from_highlight(highlight_path)
            
            if result:
                print(f"\n[CELEBRATE] 处理完成，输出文件: {result}")
            else:
                print("\n[INFO]  未生成任何文件")
                sys.exit(1)
                
    except Exception as e:
        print(f"[EXPLOSION] 处理失败: {e}")
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()