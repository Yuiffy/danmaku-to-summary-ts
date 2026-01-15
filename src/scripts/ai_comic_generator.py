#!/usr/bin/env python3
"""
AI漫画生成模块
使用Google图像生成API生成直播总结漫画
支持Google Imagen等图像生成模型
"""

import os
import sys
import json
import time
import base64
import requests
from pathlib import Path
from typing import Optional, Dict, Any, Tuple
import traceback
import subprocess
import shutil

# 配置路径
CONFIG_PATH = os.path.join(os.path.dirname(__file__), 'config.json')

def load_config() -> Dict[str, Any]:
    """加载配置文件（包括config.json和config.secrets.json），支持新旧格式"""
    default_config = {
        "aiServices": {
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
            
            # 检查新格式配置 (ai.text.gemini 和 ai.comic.tuZi)
            if "ai" in user_config:
                # 新格式：ai.text.gemini
                if "text" in user_config["ai"] and "gemini" in user_config["ai"]["text"]:
                    if "gemini" not in merged["aiServices"]:
                        merged["aiServices"]["gemini"] = {}
                    merged["aiServices"]["gemini"].update(user_config["ai"]["text"]["gemini"])
                    # 设置enabled标志
                    merged["aiServices"]["gemini"]["enabled"] = user_config["ai"]["text"].get("enabled", False)
                
                # 新格式：ai.comic.tuZi
                if "comic" in user_config["ai"]:
                    if "tuZi" in user_config["ai"]["comic"]:
                        if "tuZi" not in merged["aiServices"]:
                            merged["aiServices"]["tuZi"] = {}
                        merged["aiServices"]["tuZi"].update(user_config["ai"]["comic"]["tuZi"])
                        # 设置enabled标志
                        merged["aiServices"]["tuZi"]["enabled"] = user_config["ai"]["comic"].get("enabled", False)
            
            # 检查旧格式配置 (aiServices.gemini 和 aiServices.tuZi)
            if "aiServices" in user_config:
                if "gemini" in user_config["aiServices"]:
                    if "gemini" not in merged["aiServices"]:
                        merged["aiServices"]["gemini"] = {}
                    merged["aiServices"]["gemini"].update(user_config["aiServices"]["gemini"])
                
                if "tuZi" in user_config["aiServices"]:
                    if "tuZi" not in merged["aiServices"]:
                        merged["aiServices"]["tuZi"] = {}
                    merged["aiServices"]["tuZi"].update(user_config["aiServices"]["tuZi"])
            
            # 合并roomSettings（支持新旧格式）
            if "roomSettings" in user_config:
                merged["roomSettings"].update(user_config["roomSettings"])
            elif "ai" in user_config and "roomSettings" in user_config["ai"]:
                merged["roomSettings"].update(user_config["ai"]["roomSettings"])
            
            # 合并timeouts
            if "timeouts" in user_config:
                merged["timeouts"].update(user_config["timeouts"])
        
        # 加载密钥文件
        secrets_path = os.path.join(os.path.dirname(__file__), 'config.secrets.json')
        if os.path.exists(secrets_path):
            with open(secrets_path, 'r', encoding='utf-8') as f:
                secrets_config = json.load(f)

            # 合并密钥配置（支持新旧格式）
            if "ai" in secrets_config:
                # 新格式：ai.text.gemini.apiKey
                if "text" in secrets_config["ai"] and "gemini" in secrets_config["ai"]["text"]:
                    if "gemini" not in merged["aiServices"]:
                        merged["aiServices"]["gemini"] = {}
                    merged["aiServices"]["gemini"].update(secrets_config["ai"]["text"]["gemini"])
                
                # 新格式：ai.comic.tuZi.apiKey
                if "comic" in secrets_config["ai"] and "tuZi" in secrets_config["ai"]["comic"]:
                    if "tuZi" not in merged["aiServices"]:
                        merged["aiServices"]["tuZi"] = {}
                    merged["aiServices"]["tuZi"].update(secrets_config["ai"]["comic"]["tuZi"])
            
            # 旧格式：aiServices.gemini.apiKey 和 aiServices.tuZi.apiKey
            if "aiServices" in secrets_config:
                if "aiServices" not in merged:
                    merged["aiServices"] = {}
                for service_name, service_config in secrets_config["aiServices"].items():
                    if service_name not in merged["aiServices"]:
                        merged["aiServices"][service_name] = {}
                    merged["aiServices"][service_name].update(service_config)
        
        return merged
        
    except Exception as e:
        print(f"[ERROR] 加载配置文件失败: {e}")
        import traceback
        traceback.print_exc()
    
    return default_config

def is_huggingface_configured() -> bool:
    """检查Hugging Face配置是否有效（已禁用）"""
    return False

def is_googleimage_configured() -> bool:
    """检查Google图像生成配置是否有效（已禁用）"""
    return False

def is_tuzi_configured() -> bool:
    """检查tuZi图像生成配置是否有效"""
    config = load_config()
    tuzi_config = config["aiServices"].get("tuZi", {})
    return tuzi_config.get("enabled", False) and tuzi_config.get("apiKey", "") and tuzi_config["apiKey"].strip() != ""

def get_room_reference_image(room_id: str) -> Optional[str]:
    """获取房间的参考图片路径，支持新旧配置格式"""
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
    # 检查新格式：ai.defaultReferenceImage
    default_image = config.get("ai", {}).get("defaultReferenceImage", "")
    if not default_image:
        # 检查旧格式：aiServices.defaultReferenceImage
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

def get_room_character_description(room_id: Optional[str] = None) -> str:
    """从配置中获取房间或全局的角色描述，返回已清洗的字符串。支持新旧格式"""
    try:
        config = load_config()

        desc = ""
        if room_id:
            room_cfg = config.get("roomSettings", {}).get(str(room_id), {})
            desc = room_cfg.get("characterDescription") or room_cfg.get("characterDesc", "")

        if not desc:
            # 检查新格式：ai.defaultCharacterDescription
            desc = config.get("ai", {}).get("defaultCharacterDescription", "")
            if not desc:
                # 检查旧格式：aiServices.defaultCharacterDescription
                desc = config.get("aiServices", {}).get("defaultCharacterDescription", "")

        if not desc:
            # 内置回退描述（与原先硬编码内容一致）
            desc = "岁己SUI（白发红瞳女生），饼干岁（有细细四肢的小小的饼干状生物）"

        # 清洗：折叠换行、去两端空白、截断、去除尖括号以避免模型解析问题
        desc = " ".join([s.strip() for s in desc.splitlines() if s.strip()])
        desc = desc.replace("<", "").replace(">", "")
        if len(desc) > 400:
            desc = desc[:400]

        return desc
    except Exception:
        return "岁己SUI（白发红瞳女生），饼干岁（有细细四肢的小小的饼干状生物）"

def build_comic_prompt(highlight_content: str, reference_image_path: Optional[str] = None, room_id: Optional[str] = None, existing_comic: Optional[str] = None) -> Tuple[str, str]:
    """构建漫画生成提示词并返回 (prompt, comic_content)。

    如果提供 `existing_comic` 则复用已有脚本而不再调用AI生成。
    返回值: (base_prompt, comic_content)
    """
    # 第一步：如果传入已有脚本则复用，否则使用AI生成漫画内容脚本
    if existing_comic and existing_comic.strip() != "":
        comic_content = existing_comic
    else:
        comic_content = generate_comic_content_with_ai(highlight_content, room_id=room_id)

    # 获取角色描述并注入绘画提示词（优先房间配置、再全局默认、最后内置默认）
    character_desc = get_room_character_description(room_id)

    # 第二步：基于漫画内容构建绘画提示词（包含角色设定，便于图像生成一致）
    base_prompt = f"""<note>一定要按照给你的参考图还原形象，而不是自己乱画一个动漫角色</note>
<character>{character_desc}</character>
下面是根据直播内容生成的漫画脚本，请根据这个脚本绘制漫画：
{comic_content}"""

    return base_prompt, comic_content

def generate_comic_content_with_ai(highlight_content: str, room_id: Optional[str] = None) -> str:
    """使用AI生成漫画内容脚本"""
    print("[AI] 使用AI生成漫画内容脚本...")

    # 首先尝试复用已有的 Node 文本生成器（ai_text_generator.js），避免在 Python 中重复实现 Gemini 调用
    try:
        node_bin = shutil.which('node')
        script_path = os.path.join(os.path.dirname(__file__), 'ai_text_generator.js')
        if node_bin and os.path.exists(script_path):
            try:
                print(f"[AI] 调用 node 脚本生成文本: {script_path}")
                proc = subprocess.run(
                    [node_bin, script_path, '--generate-text'],
                    input=highlight_content.encode('utf-8'),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=os.path.dirname(__file__),
                    timeout=120
                )
                if proc.returncode == 0 and proc.stdout:
                    text = proc.stdout.decode('utf-8').strip()
                    if text:
                        print('[OK] 从 ai_text_generator 返回内容')
                        return text
                else:
                    stderr = proc.stderr.decode('utf-8') if proc.stderr else ''
                    print(f"[INFO] node 脚本返回非零状态: {proc.returncode}, stderr: {stderr}")
            except Exception as e:
                print(f"[INFO] 调用 node 脚本失败: {e}")
    except Exception:
        pass

    try:
        # 导入Google GenAI (新版本)
        import google.genai as genai

        # 加载配置
        config = load_config()

        # 获取Gemini配置（支持新旧格式）
        gemini_config = {}
        gemini_api_key = ''
        
        # 检查新格式：ai.text.gemini
        if 'ai' in config and 'text' in config['ai'] and 'gemini' in config['ai']['text']:
            gemini_config = config['ai']['text']['gemini']
            gemini_api_key = gemini_config.get('apiKey', '')
        # 检查旧格式：aiServices.gemini
        elif 'aiServices' in config and 'gemini' in config['aiServices']:
            gemini_config = config['aiServices']['gemini']
            gemini_api_key = gemini_config.get('apiKey', '')

        if not gemini_api_key:
            print("[WARNING]  Gemini API密钥未配置，使用原始内容")
            return highlight_content

        # 创建客户端
        client = genai.Client(api_key=gemini_api_key)

        # 设置代理 (如果需要)
        proxy_url = gemini_config.get('proxy', '')
        if proxy_url:
            import os
            os.environ['http_proxy'] = proxy_url
            os.environ['https_proxy'] = proxy_url

        # 获取模型名称
        model_name = gemini_config.get('model', 'gemini-1.5-flash')

        # 生成漫画内容脚本（注入配置化的角色描述）
        character_desc = get_room_character_description(room_id)
        content_prompt = f"""<job>你作为虚拟主播二创画师大手子，根据直播内容，绘制直播总结插画</job>

    <character>{character_desc}</character>

    <style>多个剪贴画风格或者少年漫多个分镜（5~8个吧），每个是一个片段场景，画图+文字台词or简介，文字要短。要画得精致，岁己要美丽动人，饼干岁要可爱。</style>

    <note>一定要按照给你的参考图还原形象，而不是自己乱画一个动漫角色</note>
    直播内容：
    {highlight_content}
    请创作漫画故事脚本："""

        # 调用Gemini
        response = client.models.generate_content(
            model=model_name,
            contents=content_prompt
        )

        if response and response.text:
            comic_content = response.text.strip()
            print("[OK] AI漫画内容生成完成")
            print(f"生成内容长度: {len(comic_content)} 字符")
            return comic_content
        else:
            print("[WARNING]  AI返回空结果，使用原始内容")
            return highlight_content

    except ImportError:
        print("[WARNING]  google-genai库未安装，使用原始内容")
        print("   请安装: pip install google-genai")
    except Exception as e:
        print(f"[ERROR]  AI内容生成失败: {e}")
        import traceback
        traceback.print_exc()

    # 失败时返回原始内容
    return highlight_content

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

def call_google_image_api(prompt: str, reference_image_path: Optional[str] = None) -> Optional[str]:
    """
    调用Google图像生成API
    使用Google的Imagen或其他图像生成模型
    支持重试机制
    """
    config = load_config()
    google_config = config["aiServices"]["googleImage"]

    if not is_googleimage_configured():
        raise ValueError("Google图像生成API未配置，请检查config.json中的apiKey")

    max_retries = google_config.get("maxRetries", 3)
    print(f"[GOOGLE] 调用Google图像生成API生成漫画... (最多重试 {max_retries} 次)")

    for attempt in range(max_retries + 1):
        try:
            if attempt > 0:
                print(f"[RETRY] 第 {attempt} 次重试...")

            # 导入Google GenAI库 (新版本)
            import google.genai as genai

            # 创建客户端
            ai = genai.GoogleGenAI(api_key=google_config["apiKey"])

            # 设置代理
            proxy_url = google_config.get("proxy", "")
            if proxy_url:
                import os
                os.environ['http_proxy'] = proxy_url
                os.environ['https_proxy'] = proxy_url
                if attempt == 0:  # 只在第一次显示代理信息
                    print(f"[PROXY] 使用代理: {proxy_url}")

            # 获取模型名称
            model_name = google_config.get("model", "imagen-3.0-generate-001")

            # 构建图像生成请求
            # 注意：Google的Imagen API可能需要不同的调用方式
            # 这里使用GenAI的图像生成功能

            # 首先尝试使用GenAI的图像生成
            try:
                # 构建提示词（优化为适合图像生成）

                # 构建提示词（优化为适合图像生成）
                image_prompt = prompt

                if attempt == 0:
                    print("[WAIT] 正在通过Google API生成图像...")

                # 生成图像
                response = ai.models.generate_content(
                    model=model_name,
                    contents=image_prompt,
                    generation_config={
                        "temperature": 0.7,
                        "top_p": 0.95,
                        "top_k": 40,
                    },
                    safety_settings=google_config.get("safetySettings", [])
                )

                # 处理响应
                if response and hasattr(response, 'candidates') and response.candidates:
                    # 检查是否有图像数据
                    for candidate in response.candidates:
                        if hasattr(candidate, 'content') and candidate.content:
                            for part in candidate.content.parts:
                                if hasattr(part, 'inline_data') and part.inline_data:
                                    # 提取图像数据
                                    image_data = part.inline_data.data
                                    mime_type = part.inline_data.mime_type

                                    # 保存图像
                                    import tempfile
                                    import uuid

                                    temp_dir = tempfile.gettempdir()
                                    extension = mime_type.split('/')[-1] if '/' in mime_type else 'png'
                                    temp_file = os.path.join(temp_dir, f"comic_google_{uuid.uuid4().hex[:8]}.{extension}")

                                    with open(temp_file, 'wb') as f:
                                        f.write(image_data)

                                    print(f"[OK] Google图像生成成功")
                                    print(f"[SAVE] 图像已保存到临时文件: {temp_file}")
                                    return temp_file

                # 如果上面的方法不工作，尝试备用方案
                if attempt == 0:
                    print("[INFO]  标准图像生成方法未返回图像，尝试备用方案...")

            except Exception as genai_error:
                print(f"[WARNING]  Generative AI图像生成失败: {genai_error}")
                if attempt == max_retries:
                    print("   重试次数已用完，尝试备用方案...")
                elif attempt < max_retries:
                    print(f"   将在 {attempt + 1} 次重试时重试...")

            # 如果不是最后一次重试，继续重试
            if attempt < max_retries:
                continue

            # 备用方案：使用Google Cloud Vertex AI API
            try:
                if attempt == 0:
                    print("[BACKUP] 尝试使用Vertex AI REST API...")

                # 构建Vertex AI请求
                import vertexai
                from vertexai.preview.vision_models import ImageGenerationModel

                # 初始化Vertex AI
                vertexai.init(project="your-project-id", location="us-central1")

                model = ImageGenerationModel.from_pretrained(model_name)

                # 生成图像
                images = model.generate_images(
                    prompt=prompt[:500],
                    number_of_images=1,
                    aspect_ratio="1:1",
                    safety_filter_level="block_some",
                    person_generation="allow_adult"
                )

                if images and len(images) > 0:
                    # 保存第一张图像
                    import tempfile
                    import uuid

                    temp_dir = tempfile.gettempdir()
                    temp_file = os.path.join(temp_dir, f"comic_vertex_{uuid.uuid4().hex[:8]}.png")

                    images[0].save(temp_file)

                    print(f"[OK] Vertex AI图像生成成功")
                    print(f"[SAVE] 图像已保存到临时文件: {temp_file}")
                    return temp_file

            except Exception as vertex_error:
                print(f"[WARNING]  Vertex AI失败: {vertex_error}")
                if attempt == max_retries:
                    print("   尝试使用简单的REST API调用...")

            # 如果不是最后一次重试，继续重试
            if attempt < max_retries:
                continue

            # 最终备用方案：使用简单的REST API调用
            if attempt == 0:
                print("[FINAL] 尝试使用简单的REST API调用...")

            # Google Cloud Imagen API端点
            api_endpoint = "https://us-central1-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/imagen-3.0-generate-001:predict"

            # 由于需要项目ID和认证，这里简化处理
            # 在实际使用中，用户需要配置正确的项目ID和认证

            print("[INFO]  Google图像生成需要配置Google Cloud项目，请参考文档进行设置")
            print("   提示: 您需要设置Google Cloud项目并启用Imagen API")

            return None

        except ImportError:
            print("[ERROR]  google-genai库未安装")
            print("   请安装: pip install google-genai")
            return None
        except Exception as e:
            print(f"[ERROR]  Google图像生成失败 (尝试 {attempt + 1}/{max_retries + 1}): {e}")
            if attempt < max_retries:
                print(f"   将重试...")
                time.sleep(2)  # 短暂等待后重试
            else:
                print(f"   重试次数已用完")
                traceback.print_exc()
                return None

    return None

def call_tuzi_image_api(prompt: str, reference_image_path: Optional[str] = None) -> Optional[str]:
    """
    调用tu-zi.com图像生成API
    使用OpenAI兼容的API接口
    """
    config = load_config()
    tuzi_config = config["aiServices"]["tuZi"]

    if not is_tuzi_configured():
        raise ValueError("tu-zi.com API未配置，请检查config.secrets.json中的apiKey")

    print("[TUZI] 调用tu-zi.com图像生成API...")

    try:
        # 设置代理
        proxy_url = tuzi_config.get("proxy", "")
        proxies = {}
        if proxy_url:
            proxies = {
                "http": proxy_url,
                "https": proxy_url
            }
            print(f"[PROXY] 使用代理: {proxy_url}")

        # 构建API请求
        base_url = tuzi_config.get("baseUrl", "https://api.tu-zi.com")
        api_url = f"{base_url}/v1/images/generations"

        headers = {
            "Authorization": f"Bearer {tuzi_config['apiKey']}",
            "Content-Type": "application/json"
        }

        # 构建请求体（兼容OpenAI格式）
        payload = {
            "model": tuzi_config.get("model", "dall-e-3"),
            "prompt": prompt[:1000],  # 限制提示词长度
            "n": 1,
            "size": "1024x1024"
        }

        print("[WAIT] 正在通过tu-zi.com API生成图像...")
        response = requests.post(api_url, headers=headers, json=payload, timeout=120, proxies=proxies)

        if response.status_code == 200:
            result = response.json()

            # 检查响应格式
            if "data" in result and len(result["data"]) > 0:
                image_url = result["data"][0].get("url")

                if image_url:
                    # 下载图像
                    print(f"[DOWNLOAD] 下载生成的图像...")
                    image_response = requests.get(image_url, timeout=60, proxies=proxies)

                    if image_response.status_code == 200:
                        # 保存图像
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
                        print(f"[ERROR] 下载图像失败: {image_response.status_code}")
                        return None
                else:
                    print("[ERROR] API响应中没有图像URL")
                    return None
            else:
                print(f"[ERROR] API响应格式异常: {result}")
                return None
        else:
            print(f"[ERROR] tu-zi.com API调用失败: {response.status_code}")
            print(f"   响应: {response.text[:500]}")
            return None

    except ImportError:
        print("[ERROR] requests库未安装")
        print("   请安装: pip install requests")
        return None
    except Exception as e:
        print(f"[ERROR] tu-zi.com图像生成失败: {e}")
        traceback.print_exc()
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
    print(f"[FILE] 处理AI_HIGHLIGHT文件: {os.path.basename(highlight_path)}")
    
    config = load_config()
    
    # 设置API启用状态（支持新旧格式）
    use_google = False
    use_tuzi = False
    
    # 检查新格式：ai.text.gemini.enabled 和 ai.comic.enabled
    if 'ai' in config:
        if 'text' in config['ai'] and 'gemini' in config['ai']['text']:
            use_google = config['ai']['text']['gemini'].get('enabled', False)
        if 'comic' in config['ai']:
            use_tuzi = config['ai']['comic'].get('enabled', False)
    
    # 检查旧格式：aiServices.gemini.enabled 和 aiServices.tuZi.enabled
    if 'aiServices' in config:
        if 'gemini' in config['aiServices']:
            use_google = use_google or config['aiServices']['gemini'].get('enabled', False)
        if 'tuZi' in config['aiServices']:
            use_tuzi = use_tuzi or config['aiServices']['tuZi'].get('enabled', False)
    
    try:
        # 检查输入文件
        if not os.path.exists(highlight_path):
            raise FileNotFoundError(f"AI_HIGHLIGHT文件不存在: {highlight_path}")
        
        # 提取房间ID（优先使用环境变量 ROOM_ID，其次从文件名提取）
        env_room = os.environ.get('ROOM_ID', '')
        filename = os.path.basename(highlight_path)
        file_room_id = extract_room_id_from_filename(filename)
        room_id = env_room if env_room and env_room.strip() != '' else (file_room_id or "unknown")

        if not room_id or str(room_id).strip() == '':
            print("[WARNING]  无法确定房间ID，使用 'unknown'")
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

        # 确定脚本文件路径，优先复用已存在的脚本以避免重复AI调用
        dir_name = os.path.dirname(highlight_path)
        base_name = os.path.basename(highlight_path).replace('_AI_HIGHLIGHT.txt', '')
        text_output_path = os.path.join(dir_name, f"{base_name}_COMIC_SCRIPT.txt")

        comic_text = None
        if os.path.exists(text_output_path):
            try:
                with open(text_output_path, 'r', encoding='utf-8') as tf:
                    comic_text = tf.read()
                print(f"[INFO]  已存在漫画脚本，复用: {os.path.basename(text_output_path)}")
            except Exception as e:
                print(f"[WARNING]  读取已存在漫画脚本失败，重新生成: {e}")

        # 构建提示词（包含漫画内容生成），如果已有脚本则复用
        prompt, comic_text = build_comic_prompt(highlight_content, reference_image_path, room_id, existing_comic=comic_text)

        # 如果刚生成了脚本且磁盘上没有文件，则先保存脚本（在生成图像之前保存）
        try:
            if not os.path.exists(text_output_path) and comic_text:
                with open(text_output_path, 'w', encoding='utf-8') as tf:
                    tf.write(comic_text)
                print(f"[OK] 漫画脚本已保存: {os.path.basename(text_output_path)}")
        except Exception as e:
            print(f"[WARNING] 保存漫画脚本失败: {e}")

        # 调用API生成漫画（按优先级顺序）
        comic_result = None

        # 1. 优先尝试Google图像生成（带重试）- 仅当配置了googleImage时
        if use_google:
            print("[GOOGLE] 使用Google图像生成API...")
            try:
                comic_result = call_google_image_api(prompt, reference_image_path)
            except KeyError as e:
                if "googleImage" in str(e):
                    print("[INFO]  Google图像生成API未配置，跳过")
                else:
                    raise
            except Exception as e:
                print(f"[ERROR] Google图像生成失败: {e}")

        # 2. 如果Google失败或未配置，尝试tu-zi.com
        if not comic_result and use_tuzi:
            print("[TUZI] 使用tu-zi.com图像生成API...")
            comic_result = call_tuzi_image_api(prompt, reference_image_path)

        if not comic_result:
            print("[ERROR] 所有图像生成API都失败，无返回结果")
            return None
        
        # 确定输出路径
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