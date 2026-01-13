#!/usr/bin/env python3
"""
测试配置加载
"""

import os
import sys
import json

# 添加当前目录到路径
sys.path.append(os.path.dirname(__file__))

# 测试配置加载
def test_config_loading():
    print("测试配置加载...")
    
    # 检查配置文件
    config_path = os.path.join(os.path.dirname(__file__), 'config.json')
    secrets_path = os.path.join(os.path.dirname(__file__), 'config.secrets.json')
    
    print(f"1. 检查配置文件: {config_path}")
    if os.path.exists(config_path):
        print("   [OK] 配置文件存在")
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                config = json.load(f)
            print("   [OK] 配置文件可解析")
            
            # 检查默认图片配置
            default_image = config.get('aiServices', {}).get('defaultReferenceImage', '')
            if default_image:
                print(f"   [OK] 默认图片配置: {default_image}")
                
                # 检查文件是否存在
                if os.path.exists(default_image):
                    print(f"   [OK] 默认图片文件存在: {os.path.basename(default_image)}")
                else:
                    # 尝试从项目根目录查找
                    project_root = os.path.join(os.path.dirname(__file__), '..', '..')
                    root_image_path = os.path.join(project_root, default_image.replace('../', ''))
                    if os.path.exists(root_image_path):
                        print(f"   [OK] 默认图片文件存在（项目根目录）: {os.path.basename(root_image_path)}")
                    else:
                        print(f"   [ERROR] 默认图片文件不存在: {default_image}")
            else:
                print("   [ERROR] 未找到默认图片配置")
                
        except Exception as e:
            print(f"   [ERROR] 配置文件解析失败: {e}")
    else:
        print("   [ERROR] 配置文件不存在")
    
    print(f"\n2. 检查密钥文件: {secrets_path}")
    if os.path.exists(secrets_path):
        print("   [OK] 密钥文件存在")
        try:
            with open(secrets_path, 'r', encoding='utf-8') as f:
                secrets = json.load(f)
            print("   [OK] 密钥文件可解析")
            
            # 检查Gemini API密钥
            gemini_key = secrets.get('aiServices', {}).get('gemini', {}).get('apiKey', '')
            if gemini_key and gemini_key.strip():
                print("   [OK] Gemini API密钥已配置")
            else:
                print("   [ERROR] Gemini API密钥未配置")
                
            # 检查Hugging Face令牌
            hf_token = secrets.get('aiServices', {}).get('huggingFace', {}).get('apiToken', '')
            if hf_token and hf_token.strip():
                print("   [OK] Hugging Face令牌已配置")
            else:
                print("   [ERROR] Hugging Face令牌未配置")
                
        except Exception as e:
            print(f"   [ERROR] 密钥文件解析失败: {e}")
    else:
        print("   [ERROR] 密钥文件不存在")
    
    print("\n3. 测试房间配置...")
    room_id = "22470216"  # 测试房间
    print(f"   测试房间: {room_id}")
    
    if 'config' in locals():
        if 'roomSettings' in config and room_id in config['roomSettings']:
            room_config = config['roomSettings'][room_id]
            print(f"   [OK] 房间 {room_id} 有特定配置")
            print(f"      referenceImage: {room_config.get('referenceImage', '未配置')}")
            print(f"      enableTextGeneration: {room_config.get('enableTextGeneration', True)}")
            print(f"      enableComicGeneration: {room_config.get('enableComicGeneration', True)}")
        else:
            print(f"   [INFO] 房间 {room_id} 无特定配置，将使用默认设置")
            print(f"      默认图片: {default_image}")
    
    print("\n4. 测试文件路径解析...")
    test_file = "2026_01_11_23_40_59_你好你好小悠复活_DDTV5_1_AI_HIGHLIGHT.txt"
    print(f"   测试文件名: {test_file}")
    
    # 提取房间ID
    import re
    match = re.match(r'^(\d+)_', test_file)
    if match:
        extracted_room_id = match.group(1)
        print(f"   [OK] 从文件名提取房间ID: {extracted_room_id}")
    else:
        print("   [ERROR] 无法从文件名提取房间ID")
    
    print("\n测试总结")
    print("===========")
    print("配置加载测试完成。")
    print("如果所有检查都通过，系统配置正确。")

if __name__ == "__main__":
    test_config_loading()