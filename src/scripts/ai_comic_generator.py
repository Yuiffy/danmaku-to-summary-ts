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
    """加载配置文件"""
    default_config = {
        "aiServices": {
            "huggingFace": {
                "enabled": True,
                "apiToken": "",
                "comicFactoryModel": "jbilcke-hf/ai-comic-factory"
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
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                user_config = json.load(f)
            
            # 深度合并配置
            import copy
            merged = copy.deepcopy(default_config)
            
            # 合并aiServices
            if "aiServices" in user_config and "huggingFace" in user_config["aiServices"]:
                merged["aiServices"]["huggingFace"].update(user_config["aiServices"]["huggingFace"])
            
            # 合并roomSettings
            if "roomSettings" in user_config:
                merged["roomSettings"].update(user_config["roomSettings"])
            
            # 合并timeouts
            if "timeouts" in user_config:
                merged["timeouts"].update(user_config["timeouts"])
            
            return merged
    except Exception as e:
        print(f"❌ 加载配置文件失败: {e}")
    
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
    
    return None

def read_highlight_file(highlight_path: str) -> str:
    """读取AI_HIGHLIGHT.txt内容"""
    try:
        with open(highlight_path, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        print(f"❌ 读取AI_HIGHLIGHT文件失败: {e}")
        raise

def extract_room_id_from_filename(filename: str) -> Optional[str]:
    """从文件名中提取房间ID"""
    # DDTV文件名格式: 26966466_20240101_120000_AI_HIGHLIGHT.txt
    import re
    match = re.match(r'^(\d+)_', filename)
    return match.group(1) if match else None

def build_comic_prompt(highlight_content: str, reference_image_path: Optional[str] = None) -> str:
    """构建漫画生成提示词"""
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
        print(f"❌ 图片编码失败: {e}")
        raise

def call_huggingface_comic_factory(prompt: str, reference_image_path: Optional[str] = None) -> Optional[str]:
    """
    调用Hugging Face AI Comic Factory API
    注意：这里使用requests直接调用，因为gradio_client在Windows上可能有兼容性问题
    """
    config = load_config()
    hf_config = config["aiServices"]["huggingFace"]
    
    if not is_huggingface_configured():
        raise ValueError("Hugging Face API未配置，请检查config.json中的apiToken")
    
    print("🎨 调用Hugging Face AI Comic Factory生成漫画...")
    
    # 这里使用Hugging Face Inference API
    # 注意：AI Comic Factory可能需要使用gradio_client，这里简化处理
    # 实际使用时可能需要安装gradio_client库
    
    try:
        # 尝试使用gradio_client
        try:
            from gradio_client import Client
            
            client = Client(hf_config["comicFactoryModel"])
            
            # 准备参数
            params = {
                "prompt": prompt,
                "style": "Japanese Manga",  # 漫画风格
                "layout": "Neutral",        # 布局风格
            }
            
            # 如果有参考图片，需要特殊处理
            if reference_image_path and os.path.exists(reference_image_path):
                print(f"📸 使用参考图片: {os.path.basename(reference_image_path)}")
                # 这里需要根据AI Comic Factory的实际API调整
                # 暂时只使用提示词
                pass
            
            print("⏳ 正在生成漫画，这可能需要几分钟...")
            result = client.predict(**params)
            
            # 处理返回结果
            if result and isinstance(result, (str, list)):
                print("✅ 漫画生成成功")
                return str(result[0] if isinstance(result, list) else result)
            else:
                print("⚠️  生成结果格式异常")
                return None
                
        except ImportError:
            print("⚠️  gradio_client未安装，使用备用方案")
            print("   请安装: pip install gradio_client")
            
            # 备用方案：使用Hugging Face Inference API
            api_url = f"https://api-inference.huggingface.co/models/{hf_config['comicFactoryModel']}"
            headers = {"Authorization": f"Bearer {hf_config['apiToken']}"}
            
            payload = {
                "inputs": prompt,
                "parameters": {
                    "max_length": 500,
                    "temperature": 0.7
                }
            }
            
            response = requests.post(api_url, headers=headers, json=payload, timeout=120)
            
            if response.status_code == 200:
                print("✅ 漫画生成成功（备用API）")
                return response.text
            else:
                print(f"❌ API调用失败: {response.status_code}")
                print(f"响应: {response.text}")
                return None
                
    except Exception as e:
        print(f"❌ 漫画生成失败: {e}")
        traceback.print_exc()
        return None

def save_comic_result(output_path: str, comic_data: Any) -> str:
    """保存漫画结果"""
    try:
        # 如果comic_data是URL，下载图片
        if isinstance(comic_data, str) and comic_data.startswith(('http://', 'https://')):
            print(f"📥 下载漫画图片: {comic_data}")
            response = requests.get(comic_data, timeout=60)
            if response.status_code == 200:
                with open(output_path, 'wb') as f:
                    f.write(response.content)
                print(f"✅ 漫画图片已保存: {os.path.basename(output_path)}")
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
                print(f"✅ 漫画图片已保存: {os.path.basename(output_path)}")
                return output_path
        
        # 其他情况，直接保存为文本（可能是错误信息或文本结果）
        else:
            with open(output_path, 'w', encoding='utf-8') as f:
                f.write(str(comic_data))
            print(f"✅ 漫画结果已保存为文本: {os.path.basename(output_path)}")
            return output_path
            
    except Exception as e:
        print(f"❌ 保存漫画结果失败: {e}")
        raise

def generate_comic_from_highlight(highlight_path: str) -> Optional[str]:
    """从AI_HIGHLIGHT文件生成漫画"""
    config = load_config()
    
    if not config["aiServices"]["huggingFace"]["enabled"]:
        print("ℹ️  AI漫画生成功能已禁用")
        return None
    
    if not is_huggingface_configured():
        print("⚠️  Hugging Face API未配置，跳过漫画生成")
        return None
    
    print(f"📄 处理AI_HIGHLIGHT文件: {os.path.basename(highlight_path)}")
    
    try:
        # 检查输入文件
        if not os.path.exists(highlight_path):
            raise FileNotFoundError(f"AI_HIGHLIGHT文件不存在: {highlight_path}")
        
        # 提取房间ID
        filename = os.path.basename(highlight_path)
        room_id = extract_room_id_from_filename(filename)
        
        if not room_id:
            print("⚠️  无法从文件名提取房间ID")
            room_id = "unknown"
        
        print(f"🏠 房间ID: {room_id}")
        
        # 获取参考图片
        reference_image_path = get_room_reference_image(room_id)
        if reference_image_path:
            print(f"🖼️  找到参考图片: {os.path.basename(reference_image_path)}")
        else:
            print("⚠️  未找到参考图片，将仅使用提示词生成")
        
        # 检查房间是否启用漫画生成
        room_str = str(room_id)
        if room_str in config["roomSettings"]:
            if not config["roomSettings"][room_str].get("enableComicGeneration", True):
                print(f"ℹ️  房间 {room_id} 的漫画生成功能已禁用")
                return None
        
        # 读取内容
        highlight_content = read_highlight_file(highlight_path)
        print(f"📖 读取内容完成 ({len(highlight_content)} 字符)")
        
        # 构建提示词
        prompt = build_comic_prompt(highlight_content, reference_image_path)
        
        # 调用API生成漫画
        comic_result = call_huggingface_comic_factory(prompt, reference_image_path)
        
        if not comic_result:
            print("❌ 漫画生成失败，无返回结果")
            return None
        
        # 确定输出路径
        dir_name = os.path.dirname(highlight_path)
        base_name = os.path.basename(highlight_path).replace('_AI_HIGHLIGHT.txt', '')
        output_path = os.path.join(dir_name, f"{base_name}_COMIC_FACTORY.png")
        
        # 保存结果
        return save_comic_result(output_path, comic_result)
        
    except Exception as e:
        print(f"❌ 生成漫画失败: {e}")
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
            print(f"🔍 批量处理目录: {directory}")
            
            if not os.path.exists(directory):
                print(f"❌ 目录不存在: {directory}")
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
                        print(f"✅ 成功生成: {os.path.basename(result)}")
                    else:
                        print("❌ 生成失败")
                except Exception as e:
                    print(f"❌ 处理失败: {e}")
            
            print(f"\n📊 批量处理完成:")
            print(f"   ✅ 成功: {success_count} 个")
            print(f"   ❌ 失败: {len(highlight_files) - success_count} 个")
            
        else:
            highlight_path = sys.argv[1]
            result = generate_comic_from_highlight(highlight_path)
            
            if result:
                print(f"\n🎉 处理完成，输出文件: {result}")
            else:
                print("\nℹ️  未生成任何文件")
                sys.exit(1)
                
    except Exception as e:
        print(f"💥 处理失败: {e}")
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()