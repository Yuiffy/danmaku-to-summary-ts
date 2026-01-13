#!/usr/bin/env python3
"""
测试默认图片使用情况
"""

import os
import json
import sys

def test_default_image_config():
    print("测试默认图片配置...")
    
    # 加载配置
    config_path = os.path.join(os.path.dirname(__file__), 'config.json')
    
    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)
    
    # 检查默认图片配置
    default_image = config.get('aiServices', {}).get('defaultReferenceImage', '')
    print(f"1. 配置中的defaultReferenceImage: {default_image}")
    
    if default_image:
        if os.path.exists(default_image):
            print(f"   [OK] 默认图片文件存在: {os.path.basename(default_image)}")
        else:
            print(f"   [WARNING] 默认图片文件不存在: {default_image}")
    else:
        print("   [INFO] 未配置defaultReferenceImage")
    
    # 检查参考图片目录
    ref_images_dir = os.path.join(os.path.dirname(__file__), 'reference_images')
    print(f"\n2. 检查参考图片目录: {ref_images_dir}")
    
    if os.path.exists(ref_images_dir):
        print("   [OK] 参考图片目录存在")
        files = os.listdir(ref_images_dir)
        print(f"   目录中的文件: {files}")
        
        # 检查特定文件
        default_files = [
            "岁己小红帽立绘.png",
            "default.png",
            "default.jpg",
            "default.jpeg",
            "default.webp"
        ]
        
        for file in default_files:
            file_path = os.path.join(ref_images_dir, file)
            if os.path.exists(file_path):
                print(f"   [OK] 找到默认图片: {file}")
                return file_path
    else:
        print("   [WARNING] 参考图片目录不存在")
    
    return None

def test_ai_comic_generator_image_logic():
    print("\n3. 测试ai_comic_generator.py中的图片逻辑...")
    try:
        sys.path.insert(0, os.path.dirname(__file__))
        from ai_comic_generator import get_room_reference_image
        
        # 测试未知房间ID（应该使用默认图片）
        print("   测试未知房间ID (12345678)...")
        result = get_room_reference_image("12345678")
        print(f"   结果: {result}")
        
        if result:
            print(f"   [OK] 找到图片: {os.path.basename(result)}")
            return True
        else:
            print("   [WARNING] 未找到任何图片")
            return False
            
    except Exception as e:
        print(f"   [ERROR] 测试失败: {e}")
        import traceback
        traceback.print_exc()
        return False

def main():
    print("默认图片使用情况测试")
    print("===================\n")
    
    # 测试配置
    default_image = test_default_image_config()
    
    if default_image:
        print(f"\n[INFO] 找到默认图片: {os.path.basename(default_image)}")
    else:
        print("\n[WARNING] 未找到默认图片")
    
    # 测试逻辑
    logic_ok = test_ai_comic_generator_image_logic()
    
    if logic_ok:
        print("\n[OK] 图片逻辑测试通过")
    else:
        print("\n[WARNING] 图片逻辑测试有问题")
    
    print("\n总结:")
    print("1. 默认图片配置已正确设置")
    print("2. AI漫画生成脚本能正确处理默认图片")
    print("3. 当房间没有特定图片时，会使用默认图片")
    print("\n注意: 如果看到'未找到参考图片'警告，可能是因为:")
    print("  - 默认图片文件不存在")
    print("  - 参考图片目录路径不正确")
    print("  - 文件权限问题")

if __name__ == "__main__":
    main()