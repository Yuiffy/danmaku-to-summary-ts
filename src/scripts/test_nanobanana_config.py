#!/usr/bin/env python3
"""
测试图像生成API配置
"""

import sys
import os

# 添加当前目录到路径
sys.path.append(os.path.dirname(__file__))

# 导入配置检查函数
from ai_comic_generator import is_tuzi_configured, load_config

def test_config():
    """测试配置是否正确"""
    print("[TEST] 测试图像生成API配置...")

    try:
        config = load_config()

        # 检查tuZi配置
        tuzi_ok = is_tuzi_configured()
        tuzi_config = config['aiServices'].get('tuZi', {})
        print(f"tuZi enabled: {tuzi_config.get('enabled', True)}")
        print(f"tuZi API key configured: {bool(tuzi_config.get('apiKey', ''))}")
        print(f"tuZi model: {tuzi_config.get('model', 'nano-banana')}")

        available_services = []
        if tuzi_ok:
            available_services.append("tu-zi.com")

        if available_services:
            print(f"[OK] 可用图像生成服务: {', '.join(available_services)}")
            return True
        else:
            print("[ERROR] 没有可用的图像生成API配置")
            return False

    except Exception as e:
        print(f"[ERROR] 测试失败: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    success = test_config()
    sys.exit(0 if success else 1)