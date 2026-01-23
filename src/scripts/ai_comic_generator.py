#!/usr/bin/env python3
"""
AI漫画生成模块
使用Google图像生成API生成直播总结漫画
支持Google Imagen等图像生成模型
"""

import os
import sys
import io

# 禁用输出缓冲，确保日志实时输出到Node.js
# 保存原始的stdout/stderr，以便在包装失败时使用
_original_stdout = sys.stdout
_original_stderr = sys.stderr

# 创建安全的打印函数，确保日志能够输出
def safe_print(*args, **kwargs):
    """安全的打印函数，尝试多种方式输出日志"""
    message = ' '.join(str(arg) for arg in args)
    
    # 尝试1: 使用原始stdout
    try:
        if not _original_stdout.closed:
            _original_stdout.write(message + '\n')
            _original_stdout.flush()
            return
    except (ValueError, OSError, AttributeError):
        pass
    
    # 尝试2: 使用内置print
    try:
        __builtins__.print(*args, **kwargs)
        return
    except (ValueError, OSError, AttributeError):
        pass
    
    # 尝试3: 直接写入sys.stdout
    try:
        if hasattr(sys.stdout, 'write') and not sys.stdout.closed:
            sys.stdout.write(message + '\n')
            sys.stdout.flush()
            return
    except (ValueError, OSError, AttributeError):
        pass
    
    # 尝试4: 写入stderr作为最后手段
    try:
        if hasattr(sys.stderr, 'write') and not sys.stderr.closed:
            sys.stderr.write(message + '\n')
            sys.stderr.flush()
            return
    except (ValueError, OSError, AttributeError):
        pass

# 创建安全的traceback打印函数
def safe_print_exc():
    """安全的traceback打印函数"""
    import traceback as tb
    try:
        tb.print_exc(file=_original_stderr)
    except (ValueError, OSError, AttributeError):
        # 尝试使用原始stderr
        try:
            _original_stderr.write(str(tb.format_exc()) + '\n')
            _original_stderr.flush()
        except:
            pass

# 全局替换内置print函数
print = safe_print

import json
import time
import base64
import requests
from pathlib import Path
from typing import Optional, Dict, Any, Tuple
import traceback as tb
import subprocess
import shutil

# 导入统一配置加载器
from config_loader import (
    get_config,
    is_gemini_configured,
    is_tuzi_configured,
    get_gemini_api_key,
    get_tuzi_api_key,
    get_room_names,
    get_project_root
)

# 导入tuZi API封装
from tuzi_chat_completions import call_tuzi_chat_completions, call_tuzi_chat_completions_for_image

def load_config() -> Dict[str, Any]:
    """加载配置文件（使用统一配置加载器）"""
    config = get_config()
    
    # 为了向后兼容，构建 aiServices 结构
    # 注意：aiServices.gemini 来自 ai.text.gemini（文本生成）
    #       aiServices.tuZi 来自 ai.comic.tuZi（图像生成）
    #       aiServices.googleImage 来自 ai.comic.googleImage（图像生成）
    legacy_config = {
        "aiServices": {
            "gemini": config.get('ai', {}).get('text', {}).get('gemini', {}),
            "tuZi": config.get('ai', {}).get('comic', {}).get('tuZi', {}),
            "googleImage": config.get('ai', {}).get('comic', {}).get('googleImage', {}),
            "defaultReferenceImage": config.get('ai', {}).get('defaultReferenceImage', ''),
            "defaultCharacterDescription": config.get('ai', {}).get('defaultCharacterDescription', ''),
            "defaultNames": config.get('ai', {}).get('defaultNames', {})
        },
        "ai": config.get('ai', {}),
        "roomSettings": config.get('ai', {}).get('roomSettings', {}),
        "timeouts": config.get('timeouts', {})
    }
    
    return legacy_config

def is_huggingface_configured() -> bool:
    """检查Hugging Face配置是否有效（已禁用）"""
    return False

def is_googleimage_configured() -> bool:
    """检查Google图像生成配置是否有效（已禁用）"""
    return False

def generate_unique_filename(base_path: str) -> str:
    """生成不重复的文件名（如果文件已存在，添加 _1, _2 等后缀）"""
    if not os.path.exists(base_path):
        return base_path
    
    dir_name = os.path.dirname(base_path)
    ext = os.path.splitext(base_path)[1]
    name_without_ext = os.path.splitext(os.path.basename(base_path))[0]
    
    counter = 1
    while True:
        new_path = os.path.join(dir_name, f"{name_without_ext}_{counter}{ext}")
        if not os.path.exists(new_path):
            return new_path
        counter += 1

def get_live_cover_image(highlight_path: str) -> Optional[str]:
    """从录制目录查找对应的直播封面图片"""
    try:
        dir_path = os.path.dirname(highlight_path)
        base_name = os.path.basename(highlight_path).replace('_AI_HIGHLIGHT.txt', '')

        # 查找.cover文件
        cover_extensions = ['.jpg', '.jpeg', '.png', '.webp']
        for ext in cover_extensions:
            cover_path = os.path.join(dir_path, f"{base_name}.cover{ext}")
            if os.path.exists(cover_path):
                print(f"[INFO]  找到直播封面: {os.path.basename(cover_path)}")
                return cover_path

        return None
    except Exception as e:
        print(f"[WARNING] 查找直播封面失败: {e}")
        return None

def get_room_reference_image(room_id: str, highlight_path: Optional[str] = None) -> Optional[str]:
    """获取房间的参考图片路径
    
    兜底策略：
    1. 优先使用 roomSettings 中配置的主播参考图
    2. 如果没有配置主播参考图，使用直播封面
    3. 只有连封面都拿不到，才使用 defaultReferenceImage
    """
    config = load_config()
    
    # 获取项目根目录
    scripts_dir = os.path.dirname(__file__)
    project_root = get_project_root()

    # 第一优先级：检查 roomSettings 中的配置（主播参考图）
    room_str = str(room_id)
    room_has_config = False  # 标记是否配置了主播参考图
    
    if room_str in config["roomSettings"]:
        ref_image = config["roomSettings"][room_str].get("referenceImage", "")
        if ref_image:
            room_has_config = True
            # 尝试相对于项目根目录的路径
            absolute_path = os.path.join(project_root, ref_image) if not os.path.isabs(ref_image) else ref_image
            if os.path.exists(absolute_path):
                print(f"[INFO]  使用主播参考图: {os.path.basename(absolute_path)}")
                return absolute_path
            # 尝试相对于脚本目录的路径
            script_relative = os.path.join(scripts_dir, ref_image) if not os.path.isabs(ref_image) else ref_image
            if os.path.exists(script_relative):
                print(f"[INFO]  使用主播参考图: {os.path.basename(script_relative)}")
                return script_relative
            
            print(f"[WARNING] 配置的主播参考图不存在: {ref_image}")

        # 如果配置了但文件不存在，尝试在reference_images目录中查找
        if not room_has_config:
            ref_images_dir = os.path.join(scripts_dir, "reference_images")
            if os.path.exists(ref_images_dir):
                possible_files = [
                    os.path.join(ref_images_dir, f"{room_id}.jpg"),
                    os.path.join(ref_images_dir, f"{room_id}.jpeg"),
                    os.path.join(ref_images_dir, f"{room_id}.png"),
                    os.path.join(ref_images_dir, f"{room_id}.webp")
                ]
                for file_path in possible_files:
                    if os.path.exists(file_path):
                        print(f"[INFO]  使用主播参考图: {os.path.basename(file_path)}")
                        return file_path

    # 第二优先级：如果没有配置主播参考图，尝试使用直播封面
    if not room_has_config and highlight_path:
        live_cover = get_live_cover_image(highlight_path)
        if live_cover:
            print(f"[INFO]  未配置主播参考图，使用直播封面: {os.path.basename(live_cover)}")
            return live_cover

    # 第三优先级（兜底）：只有连封面都拿不到，才使用默认参考图片
    # 新格式：ai.defaultReferenceImage 或 ai.comic.defaultReferenceImage
    default_image = ""
    if "ai" in config:
        if config["ai"].get("defaultReferenceImage"):
            default_image = config["ai"]["defaultReferenceImage"]
        elif config["ai"].get("comic", {}).get("defaultReferenceImage"):
            default_image = config["ai"]["comic"]["defaultReferenceImage"]
    # 兼容旧格式
    if not default_image and config.get("aiServices", {}).get("defaultReferenceImage"):
        default_image = config["aiServices"]["defaultReferenceImage"]
    
    if default_image:
        # 尝试相对于项目根目录的路径
        absolute_path = os.path.join(project_root, default_image) if not os.path.isabs(default_image) else default_image
        if os.path.exists(absolute_path):
            print(f"[INFO]  使用默认参考图片（兜底）: {os.path.basename(absolute_path)}")
            return absolute_path
        # 尝试相对于脚本目录的路径
        script_relative = os.path.join(scripts_dir, default_image) if not os.path.isabs(default_image) else default_image
        if os.path.exists(script_relative):
            print(f"[INFO]  使用默认参考图片（兜底）: {os.path.basename(script_relative)}")
            return script_relative

    # 检查默认图片文件是否存在
    # 先尝试 public/reference_images（新位置）
    public_ref_dir = os.path.join(project_root, "public", "reference_images")
    for ref_dir in [public_ref_dir, os.path.join(scripts_dir, "reference_images")]:
        if os.path.exists(ref_dir):
            default_files = [
                os.path.join(ref_dir, "default.jpg"),
                os.path.join(ref_dir, "default.jpeg"),
                os.path.join(ref_dir, "default.png"),
                os.path.join(ref_dir, "default.webp"),
                os.path.join(ref_dir, "岁己小红帽立绘.png"),  # 特定文件名
                os.path.join(ref_dir, "雪绘.png")  # 雪绘特定文件
            ]
            for file_path in default_files:
                if os.path.exists(file_path):
                    print(f"[INFO]  找到默认图片（兜底）: {os.path.basename(file_path)}")
                    return file_path

    return None

def collect_all_images(room_id: str, highlight_path: Optional[str] = None) -> list[str]:
    """收集所有可用的图片（引用图、封面、截图）用于AI输入
    
    返回图片路径列表，按优先级排序：
    1. 引用图片（通过 get_room_reference_image 获取，已实现兜底策略：主播参考图 → 封面 → 默认图）
    2. 直播封面（.cover文件，如果与引用图不同则额外添加）
    3. 直播截图（_SCREENSHOTS.jpg）
    """
    images = []
    
    # 1. 获取引用图片（已实现兜底策略：主播参考图 → 封面 → 默认图）
    reference_image = get_room_reference_image(room_id, highlight_path)
    if reference_image:
        images.append(reference_image)
        print(f"[INFO]  收集到引用图片: {os.path.basename(reference_image)}")
    
    # 2. 获取直播封面（如果与引用图不同则额外添加）
    if highlight_path:
        cover_image = get_live_cover_image(highlight_path)
        if cover_image and cover_image not in images:
            images.append(cover_image)
            print(f"[INFO]  收集到直播封面（额外）: {os.path.basename(cover_image)}")
    
    # 3. 获取直播截图（从环境变量）
    screenshot_path = os.environ.get('SCREENSHOT_PATH', '')
    if screenshot_path and os.path.exists(screenshot_path) and screenshot_path not in images:
        images.append(screenshot_path)
        print(f"[INFO]  收集到直播截图: {os.path.basename(screenshot_path)}")
    
    # 如果没有截图路径，尝试从highlight_path推断
    if not screenshot_path and highlight_path:
        dir_path = os.path.dirname(highlight_path)
        base_name = os.path.basename(highlight_path).replace('_AI_HIGHLIGHT.txt', '')
        inferred_screenshot = os.path.join(dir_path, f"{base_name}_SCREENSHOTS.jpg")
        if os.path.exists(inferred_screenshot) and inferred_screenshot not in images:
            images.append(inferred_screenshot)
            print(f"[INFO]  收集到推断的直播截图: {os.path.basename(inferred_screenshot)}")
    
    print(f"[INFO]  共收集到 {len(images)} 张图片用于AI输入")
    return images


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
    """从配置中获取房间或全局的角色描述，返回已清洗的字符串。"""
    try:
        config = load_config()

        desc = ""
        if room_id:
            room_cfg = config.get("roomSettings", {}).get(str(room_id), {})
            desc = room_cfg.get("characterDescription") or room_cfg.get("characterDesc", "")

        if not desc:
            # 新格式：从 ai.defaultCharacterDescription 读取
            if "ai" in config and config["ai"].get("defaultCharacterDescription"):
                desc = config["ai"]["defaultCharacterDescription"]
            # 兼容旧格式
            elif config.get("aiServices", {}).get("defaultCharacterDescription"):
                desc = config["aiServices"]["defaultCharacterDescription"]

        if not desc:
            # 内置回退描述（与原先硬编码内容一致）
            desc = "岁己SUI（白发红瞳女生），饼干岁（有细细四肢的小小小的饼干状生物）"

        # 清洗：折叠换行、去两端空白、截断、去除尖括号以避免模型解析问题
        desc = " ".join([s.strip() for s in desc.splitlines() if s.strip()])
        desc = desc.replace("<", "").replace(">", "")
        if len(desc) > 400:
            desc = desc[:400]

        return desc
    except Exception:
        return "岁己SUI（白发红瞳女生），饼干岁（有细细四肢的小小的饼干状生物）"

def build_comic_prompt(highlight_content: str, reference_image_path: Optional[str] = None, room_id: Optional[str] = None, existing_comic: Optional[str] = None) -> Tuple[str, str, bool]:
    """构建漫画生成提示词并返回 (prompt, comic_content, is_generated)。

    如果提供 `existing_comic` 则复用已有脚本而不再调用AI生成。
    返回值: (base_prompt, comic_content, is_generated)
    is_generated: 是否真正生成了漫画脚本（True）还是使用原文或已有脚本（False）
    """
    # 第一步：如果传入已有脚本则复用，否则使用AI生成漫画内容脚本
    is_generated = False
    if existing_comic and existing_comic.strip() != "":
        comic_content = existing_comic
        is_generated = True  # 复用已有脚本也算成功，允许继续生成图像
    else:
        comic_content, is_generated = generate_comic_content_with_ai(highlight_content, room_id=room_id)

    # 获取角色描述并注入绘画提示词（优先房间配置、再全局默认、最后内置默认）
    character_desc = get_room_character_description(room_id)

    # 尝试获取房间级别的自定义图片生成 prompt
    config = load_config()
    room_config = config.get("roomSettings", {}).get(str(room_id), {}) if room_id else {}
    custom_image_prompt = room_config.get("customPrompts", {}).get("comicImage")

    # 第二步：基于漫画内容构建绘画提示词（包含角色设定，便于图像生成一致）
    if custom_image_prompt:
        # 使用自定义 prompt 模板
        base_prompt = custom_image_prompt.replace("{character_desc}", character_desc).replace("{comic_content}", comic_content)
    else:
        # 使用默认模板
        base_prompt = f"""<note>一定要按照给你的参考图还原形象，而不是自己乱画一个动漫角色</note>
<character>{character_desc}</character>
要画得精致，角色要画得帅气、美丽、可爱。
尽量不要有汉字，除非就一两个字。
下面是根据直播内容生成的漫画脚本，请根据这个脚本绘制漫画：
{comic_content}"""

    return base_prompt, comic_content, is_generated


# 虚拟主播二创画师大手子的统一prompt模板（方便统一修改）
# 文字prompt: 画图+文字台词or简介，可以没有文字，有的话要很短（5个单词内），不要用中文。
COMIC_ARTIST_PROMPT_TEMPLATE = """你作为虚拟主播二创画师大手子，根据直播内容，绘制直播总结插画。
角色描述：{character_desc}。
风格：多个剪贴画风格分镜（2~4个吧），每个是一个片段场景，
不要有文字，纯默剧，用表情和动作、场景、图标来表现。
下面是一场直播的语音+弹幕文本，请先构思图片并用文字给我，我再拿去绘制图片。整体600个字符以内。只返回各个分镜的文字描述，不要包含任何多余的说明、格式。
{highlight_content}
"""

def build_comic_generation_prompt(character_desc: str, highlight_content: str, room_id: Optional[str] = None) -> str:
    """使用COMIC_ARTIST_PROMPT_TEMPLATE构建完整的prompt（用于Gemini等调用）"""
    # 尝试获取房间级别的自定义漫画脚本 prompt
    config = load_config()
    room_config = config.get("roomSettings", {}).get(str(room_id), {}) if room_id else {}
    custom_prompt = room_config.get("customPrompts", {}).get("comicScript")
    
    # 如果有自定义 prompt，使用它
    if custom_prompt:
        template = custom_prompt.strip()
    else:
        # 否则使用默认模板
        template = COMIC_ARTIST_PROMPT_TEMPLATE.strip()
    
    base = template.replace("{character_desc}", character_desc)
    base = base.replace("{highlight_content}", highlight_content)
    return base


def is_gemini_error(text: str) -> bool:
    """检测文本是否包含Gemini错误信息"""
    if not text:
        return False
    return 'Gemini Error' in text

def generate_comic_content_with_ai(highlight_content: str, room_id: Optional[str] = None) -> Tuple[str, bool]:
    """使用AI生成漫画内容脚本
    
    返回值: (comic_content, is_generated)
    is_generated: 是否真正生成了脚本（True）还是返回原文作为备选（False）
    """
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
                    if text and not is_gemini_error(text):
                        print('[OK] 从 ai_text_generator 返回内容')
                        return text, True
                    elif is_gemini_error(text):
                        print('[WARNING] ai_text_generator 返回了错误内容，尝试其他方案')
                    else:
                        stderr = proc.stderr.decode('utf-8') if proc.stderr else ''
                        print(f"[INFO] node 脚本返回非零状态: {proc.returncode}, stderr: {stderr}")
            except Exception as e:
                print(f"[INFO] 调用 node 脚本失败: {e}")
    except Exception:
        pass

    # Gemini重试逻辑
    max_gemini_retries = 3
    for gemini_attempt in range(max_gemini_retries):
        try:
            # 导入Google GenAI (新版本)
            from google import genai
            from google.genai import types

            # 获取Gemini API密钥（使用统一配置加载器）
            gemini_api_key = get_gemini_api_key()

            if not gemini_api_key:
                print("[WARNING]  Gemini API密钥未配置，使用原始内容")
                return highlight_content, False

            # 加载配置获取其他参数
            config = load_config()
            gemini_config = config.get('aiServices', {}).get('gemini', {})

            # 创建客户端（增加超时时间到120秒以应对SSL握手超时）
            client = genai.Client(api_key=gemini_api_key, http_options=types.HttpOptions(timeout=120))

            # 设置代理 (如果需要)
            proxy_url = gemini_config.get('proxy', '')
            if proxy_url:
                import os
                os.environ['http_proxy'] = proxy_url
                os.environ['https_proxy'] = proxy_url

            # 获取模型名称
            model_name = gemini_config.get('model', 'gemini-2.0-flash')

            # 生成漫画内容脚本（使用统一的prompt模板）
            character_desc = get_room_character_description(room_id)
            content_prompt = build_comic_generation_prompt(character_desc, highlight_content, room_id)

            # 调用Gemini
            if gemini_attempt > 0:
                print(f"[RETRY] 第 {gemini_attempt + 1} 次重试 Gemini...")
            print(f"[AI] 使用Gemini生成漫画内容脚本: {model_name}")
            response = client.models.generate_content(
                model=model_name,
                contents=content_prompt
            )

            if response and response.text:
                comic_content = response.text.strip()
                
                # 检测是否包含错误信息
                if is_gemini_error(comic_content):
                    print(f"[WARNING] Gemini返回了错误内容 (尝试 {gemini_attempt + 1}/{max_gemini_retries})")
                    if gemini_attempt < max_gemini_retries - 1:
                        print("[RETRY] 2秒后重试...")
                        time.sleep(2)
                        continue
                    else:
                        print("[ERROR] Gemini重试次数已用完，尝试备用方案")
                        break
                
                print("[OK] AI漫画内容生成完成")
                print(f"生成内容长度: {len(comic_content)} 字符")
                return comic_content, True
            else:
                print("[WARNING]  AI返回空结果，使用原始内容")
                return highlight_content, False

        except ImportError:
            print("[WARNING]  google-genai库未安装，尝试使用tuZi API...")
            print("   请安装: pip install google-genai")
            break
        except Exception as e:
            error_msg = str(e)
            print(f"[ERROR]  AI内容生成失败 (尝试 {gemini_attempt + 1}/{max_gemini_retries}): {e}")
            
            # 检测是否是SSL相关错误
            is_ssl_error = any(keyword in error_msg.lower() for keyword in ['ssl', 'handshake', 'timed out', 'timeout'])
            
            if gemini_attempt < max_gemini_retries - 1:
                # SSL错误使用更长的重试间隔
                retry_delay = 5 if is_ssl_error else 2
                print(f"[RETRY] {retry_delay}秒后重试...")
                time.sleep(retry_delay)
                continue
            else:
                print("[ERROR] Gemini重试次数已用完，尝试备用方案")
                break
    
    # Gemini失败后，尝试使用tuZi API作为备用方案
    print("[TUZI] Google生成失败，尝试tu-zi.com生成文本...")
    
    # 尝试使用tuZi API生成文本（带重试机制）
    max_tuzi_retries = 3
    for tuzi_attempt in range(max_tuzi_retries):
        try:
            from tuzi_chat_completions import call_tuzi_chat_completions
            
            config = load_config()
            tuzi_config = config.get("aiServices", {}).get("tuZi", {})
            
            if not is_tuzi_configured():
                print("[WARNING]  tuZi API未配置，使用原始内容")
                return highlight_content, False
            
            # 构建提示词（使用统一的prompt模板）
            character_desc = get_room_character_description(room_id)
            system_prompt = build_comic_generation_prompt(character_desc, highlight_content, room_id)
            user_prompt = f"直播内容：\n{highlight_content}\n\n请创作漫画故事脚本："
            
            if tuzi_attempt > 0:
                print(f"[RETRY] 第 {tuzi_attempt + 1} 次重试 tuZi API...")
            
            # 调用tuZi Chat Completions API
            comic_content = call_tuzi_chat_completions(
                prompt=user_prompt,
                system_prompt=system_prompt,
                model=tuzi_config.get("textModel", "gemini-3-flash-preview"),
                base_url=tuzi_config.get("baseUrl", "https://api.tu-zi.com"),
                api_key=tuzi_config.get("apiKey", ""),
                proxy_url=tuzi_config.get("proxy", ""),
                timeout=120,
                temperature=0.7,
                max_tokens=100000
            )
            
            if comic_content:
                # 检测是否包含Gemini错误信息
                if is_gemini_error(comic_content):
                    print(f"[WARNING] tuZi API返回了Gemini错误内容 (尝试 {tuzi_attempt + 1}/{max_tuzi_retries})")
                    if tuzi_attempt < max_tuzi_retries - 1:
                        print("[RETRY] 2秒后重试...")
                        time.sleep(2)
                        continue
                    else:
                        print("[ERROR] tuZi API重试次数已用完，使用原始内容")
                        return highlight_content, False
                
                print("[OK] tuZi API漫画文本生成成功")
                print(f"生成内容长度: {len(comic_content)} 字符")
                print(f"内容预览: {comic_content[:200]}...")
                return comic_content, True
            else:
                print("[WARNING]  tuZi API返回空内容")
                if tuzi_attempt < max_tuzi_retries - 1:
                    print("[RETRY] 2秒后重试...")
                    time.sleep(2)
                    continue
                else:
                    return highlight_content, False
            
        except Exception as tuzi_error:
            print(f"[ERROR]  tuZi API备用方案失败 (尝试 {tuzi_attempt + 1}/{max_tuzi_retries}): {tuzi_error}")
            if tuzi_attempt < max_tuzi_retries - 1:
                print("[RETRY] 2秒后重试...")
                time.sleep(2)
                continue
            else:
                print("[WARNING]  所有API都失败，使用原始内容")
                return highlight_content, False
    
    # 确保函数在所有路径都返回有效值
    return highlight_content, False

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
    google_config = config.get("aiServices", {}).get("googleImage", {})

    if not is_googleimage_configured():
        print("[WARNING]  Google图像生成API未配置，跳过Google图像生成")
        return None

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

                # 生成图像（60秒超时）
                response = ai.models.generate_content(
                    model=model_name,
                    contents=image_prompt,
                    generation_config={
                        "temperature": 0.7,
                        "top_p": 0.95,
                        "top_k": 40,
                    },
                    safety_settings=google_config.get("safetySettings", []),
                    timeout=60
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
                safe_print_exc()
                return None

    return None

def call_tuzi_image_api(prompt: str, reference_image_path: Optional[str] = None) -> Optional[str]:
    """
    调用tu-zi.com图像生成API
    使用 /v1/chat/completions 端点，支持参考图
    """
    config = load_config()
    tuzi_config = config["aiServices"]["tuZi"]

    if not is_tuzi_configured():
        print("[WARNING]  tu-zi.com API未配置，跳过 tu-zi.com 调用")
        return None

    if reference_image_path and os.path.exists(reference_image_path):
        print(f"[TUZI] 调用tu-zi.com图像生成API (参考图: {os.path.basename(reference_image_path)})...")
    else:
        print("[TUZI] 调用tu-zi.com图像生成API...")

    # 获取超时设置 (默认为360秒)
    timeout_ms = config.get("timeouts", {}).get("aiApiTimeout", 360000)
    timeout_sec = timeout_ms / 1000

    # 模型列表（按优先级）
    models = [
        tuzi_config.get("model", "gpt-image-1.5"),
        "gpt-image-1.5",
        "gemini-2.5-flash-image-vip",
        "gemini-3-pro-image-preview/nano-banana-2"
    ]

    # 重试逻辑
    for attempt, model in enumerate(models):
        result = call_tuzi_chat_completions_for_image(
            prompt=prompt,
            reference_image_path=reference_image_path,
            model=model,
            base_url=tuzi_config.get("baseUrl", "https://api.tu-zi.com"),
            api_key=tuzi_config.get("apiKey", ""),
            proxy_url=tuzi_config.get("proxy", ""),
            timeout=timeout_sec,
            temperature=0.7,
            max_tokens=100000
        )
        if result:
            return result

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
        safe_print_exc()
        return None

def save_comic_result(output_path: str, comic_data: Any) -> str:
    """保存漫画结果"""
    try:
        # 生成不重复的文件名
        unique_path = generate_unique_filename(output_path)
        
        # 如果comic_data是文件路径，复制文件
        if isinstance(comic_data, str) and os.path.exists(comic_data):
            print(f"[COPY] 复制漫画图片: {os.path.basename(comic_data)}")
            import shutil
            shutil.copy2(comic_data, unique_path)
            print(f"[OK] 漫画图片已保存: {os.path.basename(unique_path)}")
            return unique_path
        
        # 如果comic_data是URL，下载图片
        elif isinstance(comic_data, str) and comic_data.startswith(('http://', 'https://')):
            print(f"[DOWNLOAD] 下载漫画图片: {comic_data}")
            response = requests.get(comic_data, timeout=60)
            if response.status_code == 200:
                with open(unique_path, 'wb') as f:
                    f.write(response.content)
                print(f"[OK] 漫画图片已保存: {os.path.basename(unique_path)}")
                return unique_path
            else:
                raise ValueError(f"下载失败: {response.status_code}")
        
        # 如果comic_data是base64编码的图片
        elif isinstance(comic_data, str) and len(comic_data) > 100 and 'data:image' in comic_data:
            # 提取base64数据
            import re
            match = re.search(r'base64,(.+)', comic_data)
            if match:
                image_data = base64.b64decode(match.group(1))
                with open(unique_path, 'wb') as f:
                    f.write(image_data)
                print(f"[OK] 漫画图片已保存: {os.path.basename(unique_path)}")
                return unique_path
        
        # 其他情况，直接保存为文本（可能是错误信息或文本结果）
        else:
            with open(unique_path, 'w', encoding='utf-8') as f:
                f.write(str(comic_data))
            print(f"[OK] 漫画结果已保存为文本: {os.path.basename(unique_path)}")
            return unique_path
            
    except Exception as e:
        print(f"[ERROR] 保存漫画结果失败: {e}")
        raise

def generate_comic_from_highlight(highlight_path: str, room_id: Optional[str] = None) -> Optional[str]:
    """从AI_HIGHLIGHT文件生成漫画"""
    print(f"[FILE] 处理AI_HIGHLIGHT文件: {os.path.basename(highlight_path)}")
    
    config = load_config()
    
    # 设置API启用状态
    # 注意：这里检查的是图像生成API的启用状态，不是文本生成API
    use_google = config["aiServices"].get("googleImage", {}).get("enabled", False)
    use_tuzi = config["aiServices"].get("tuZi", {}).get("enabled", False)
    
    try:
        # 检查输入文件
        if not os.path.exists(highlight_path):
            raise FileNotFoundError(f"AI_HIGHLIGHT文件不存在: {highlight_path}")
        
        # 提取房间ID（优先使用传入的 room_id，其次从文件名提取）
        if room_id is None:
            filename = os.path.basename(highlight_path)
            file_room_id = extract_room_id_from_filename(filename)
            room_id = file_room_id or "unknown"

        if not room_id or str(room_id).strip() == '':
            print("[WARNING]  无法确定房间ID，使用 'unknown'")
            room_id = "unknown"

        print(f"[ROOM] 房间ID: {room_id}")
        
        # 获取参考图片
        reference_image_path = get_room_reference_image(room_id, highlight_path)
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
        prompt, comic_text, is_comic_generated = build_comic_prompt(highlight_content, reference_image_path, room_id, existing_comic=comic_text)

        # 如果脚本生成失败（使用原文作为备选），则不生成图片
        if not is_comic_generated:
            print("[ERROR] 漫画脚本生成失败，跳过图像生成")
            return None

        # 图像生成成功，现在保存漫画脚本（只在真正生成脚本时保存，不保存原文备选）
        try:
            if not os.path.exists(text_output_path) and comic_text and is_comic_generated:
                with open(text_output_path, 'w', encoding='utf-8') as tf:
                    tf.write(comic_text)
                print(f"[OK] 漫画脚本已保存: {os.path.basename(text_output_path)}")
        except Exception as e:
            print(f"[WARNING] 保存漫画脚本失败: {e}")

        # 调用API生成漫画（按优先级顺序）
        comic_result = None

        # 1. 优先尝试Google图像生成（带重试）
        if use_google:
            print("[GOOGLE] 使用Google图像生成API...")
            comic_result = call_google_image_api(prompt, reference_image_path)
            if comic_result:
                print(f"[DEBUG] Google API返回结果: {comic_result}")
            else:
                print("[DEBUG] Google API返回None")

        # 2. 如果Google失败，尝试tu-zi.com作为最终备用方案
        if not comic_result and use_tuzi:
            print("[TUZI] Google生成失败，尝试tu-zi.com...")
            comic_result = call_tuzi_image_api(prompt, reference_image_path)
            if comic_result:
                print(f"[DEBUG] tu-zi.com返回结果: {comic_result}")
            else:
                print("[DEBUG] tu-zi.com返回None")

        if not comic_result:
            print("[ERROR] 所有图像生成API都失败，无返回结果")
            return None
        
        print(f"[DEBUG] comic_result类型: {type(comic_result)}, 内容: {comic_result}")
        
        # 确定输出路径
        output_path = os.path.join(dir_name, f"{base_name}_COMIC_FACTORY.png")
        print(f"[DEBUG] 输出路径: {output_path}")

        # 保存结果
        return save_comic_result(output_path, comic_result)
        
    except Exception as e:
        print(f"[ERROR] 生成漫画失败: {e}")
        safe_print_exc()
        return None

def main():
    """主函数"""
    if len(sys.argv) < 2:
        print("用法: python ai_comic_generator.py <AI_HIGHLIGHT.txt路径> [--room-id <房间ID>]")
        print("或:    python ai_comic_generator.py --batch <目录路径>")
        sys.exit(1)
    
    try:
        # 解析命令行参数
        room_id = None
        highlight_path = None
        batch_mode = False
        directory = None
        
        i = 1
        while i < len(sys.argv):
            arg = sys.argv[i]
            if arg == "--batch":
                batch_mode = True
                if i + 1 < len(sys.argv):
                    directory = sys.argv[i + 1]
                    i += 1
            elif arg == "--room-id":
                if i + 1 < len(sys.argv):
                    room_id = sys.argv[i + 1]
                    i += 1
            elif not arg.startswith("-"):
                highlight_path = arg
            i += 1
        
        if batch_mode:
            if not directory:
                print("[ERROR] 批量模式需要指定目录")
                sys.exit(1)
                
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
                    result = generate_comic_from_highlight(file_path, room_id)
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
            if not highlight_path:
                print("[ERROR] 需要指定AI_HIGHLIGHT文件路径")
                sys.exit(1)
                
            result = generate_comic_from_highlight(highlight_path, room_id)
            
            if result:
                print(f"\n[CELEBRATE] 处理完成，输出文件: {result}")
            else:
                print("\n[INFO]  未生成任何文件（已安全完成，退出码 0）")
                sys.exit(0)
                
    except Exception as e:
        print(f"[EXPLOSION] 处理失败: {e}")
        safe_print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()