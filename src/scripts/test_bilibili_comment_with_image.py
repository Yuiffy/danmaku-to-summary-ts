#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试带图片的B站评论发布功能
"""

import json
import asyncio
import sys
import os

# 添加src/scripts目录到Python路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from scripts.bilibili_comment import publish_comment


def load_bilibili_config():
    """从配置文件加载B站Cookie"""
    config_path = os.path.join(os.path.dirname(__file__), '..', '..', 'config', 'secret.json')

    if not os.path.exists(config_path):
        print(f"[ERROR] 配置文件不存在: {config_path}")
        return None

    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)

    bilibili_config = config.get('bilibili', {})
    cookie = bilibili_config.get('cookie', '')
    csrf = bilibili_config.get('csrf', '')

    if not cookie:
        print("[ERROR] 配置文件中未找到B站Cookie")
        return None

    # 从Cookie中提取SESSDATA, bili_jct, DedeUserID
    sessdata = None
    bili_jct = csrf
    dedeuserid = None

    for item in cookie.split(';'):
        item = item.strip()
        if item.startswith('SESSDATA='):
            sessdata = item[9:]
        elif item.startswith('DedeUserID='):
            dedeuserid = item[11:]

    if not sessdata or not bili_jct or not dedeuserid:
        print("[ERROR] Cookie中缺少必要的参数 (SESSDATA, bili_jct, DedeUserID)")
        return None

    return {
        'sessdata': sessdata,
        'bili_jct': bili_jct,
        'dedeuserid': dedeuserid
    }


async def test_upload_image():
    """测试图片上传功能（通过发布评论来测试）"""
    # 测试动态ID（需要替换为实际的动态ID）
    dynamic_id = os.environ.get('TEST_DYNAMIC_ID', '1153657516031213571')
    content = "测试图片上传~"

    # 从配置文件读取Cookie
    bilibili_config = load_bilibili_config()
    if not bilibili_config:
        return None

    sessdata = bilibili_config['sessdata']
    bili_jct = bilibili_config['bili_jct']
    dedeuserid = bilibili_config['dedeuserid']

    # 使用项目中的测试图片
    test_image_path = os.path.join(os.path.dirname(__file__), 'test_data', 'test_COMIC_FACTORY.png')

    # 如果测试图片不存在，使用public/reference_images中的图片
    if not os.path.exists(test_image_path):
        test_image_path = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'reference_images', '岁己小红帽立绘.png')

    if not os.path.exists(test_image_path):
        print(f"[ERROR] 测试图片不存在: {test_image_path}")
        return None

    print(f"=== 测试图片上传（通过发布评论） ===")
    print(f"动态ID: {dynamic_id}")
    print(f"评论内容: {content}")
    print(f"图片路径: {test_image_path}\n")

    try:
        result = await publish_comment(dynamic_id, content, sessdata, bili_jct, dedeuserid, test_image_path)
        print(f"\n评论发布结果:")
        print(json.dumps(result, ensure_ascii=False, indent=2))

        if result['success']:
            print(f"\n测试成功!")
            print(f"回复ID: {result.get('reply_id')}")
            print(f"图片URL: {result.get('image_url')}")
            return result.get('image_url')
        else:
            print(f"\n测试失败: {result.get('message')}")
            return None
    except Exception as e:
        print(f"测试失败: {e}")
        import traceback
        traceback.print_exc()
        return None


async def test_comment_with_image():
    """测试带图片的评论发布"""
    # 测试动态ID（需要替换为实际的动态ID）
    dynamic_id = os.environ.get('TEST_DYNAMIC_ID', '1153657516031213571')
    content = "测试带图片的评论~"

    # 从配置文件读取Cookie
    bilibili_config = load_bilibili_config()
    if not bilibili_config:
        return

    sessdata = bilibili_config['sessdata']
    bili_jct = bilibili_config['bili_jct']
    dedeuserid = bilibili_config['dedeuserid']

    # 使用项目中的测试图片
    test_image_path = os.path.join(os.path.dirname(__file__), 'test_data', 'test_COMIC_FACTORY.png')

    # 如果测试图片不存在，使用public/reference_images中的图片
    if not os.path.exists(test_image_path):
        test_image_path = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'reference_images', '岁己小红帽立绘.png')

    if not os.path.exists(test_image_path):
        print(f"[ERROR] 测试图片不存在: {test_image_path}")
        return

    print(f"=== 测试带图片的评论发布 ===")
    print(f"动态ID: {dynamic_id}")
    print(f"评论内容: {content}")
    print(f"图片路径: {test_image_path}\n")

    try:
        result = await publish_comment(dynamic_id, content, sessdata, bili_jct, dedeuserid, test_image_path)
        print(f"\n评论发布结果:")
        print(json.dumps(result, ensure_ascii=False, indent=2))

        if result['success']:
            print(f"\n测试成功!")
            print(f"回复ID: {result.get('reply_id')}")
            print(f"图片URL: {result.get('image_url')}")
        else:
            print(f"\n测试失败: {result.get('message')}")
    except Exception as e:
        print(f"测试失败: {e}")
        import traceback
        traceback.print_exc()


async def test_comment_without_image():
    """测试不带图片的评论发布"""
    # 测试动态ID（需要替换为实际的动态ID）
    dynamic_id = os.environ.get('TEST_DYNAMIC_ID', '1153657516031213571')
    content = "测试不带图片的评论~"

    # 从配置文件读取Cookie
    bilibili_config = load_bilibili_config()
    if not bilibili_config:
        return

    sessdata = bilibili_config['sessdata']
    bili_jct = bilibili_config['bili_jct']
    dedeuserid = bilibili_config['dedeuserid']

    print(f"=== 测试不带图片的评论发布 ===")
    print(f"动态ID: {dynamic_id}")
    print(f"评论内容: {content}\n")

    try:
        result = await publish_comment(dynamic_id, content, sessdata, bili_jct, dedeuserid)
        print(f"\n评论发布结果:")
        print(json.dumps(result, ensure_ascii=False, indent=2))

        if result['success']:
            print(f"\n测试成功!")
            print(f"回复ID: {result.get('reply_id')}")
        else:
            print(f"\n测试失败: {result.get('message')}")
    except Exception as e:
        print(f"测试失败: {e}")
        import traceback
        traceback.print_exc()


def main():
    """主函数"""
    print("B站带图片评论测试脚本")
    print("=" * 50)
    print()

    # 检查配置文件
    bilibili_config = load_bilibili_config()
    if not bilibili_config:
        print("[ERROR] 无法加载B站配置")
        print("请确保 config/secret.json 文件存在且包含有效的B站Cookie")
        return

    print("[OK] B站配置加载成功")
    print()

    # 从命令行参数获取测试类型，如果没有参数则使用默认值
    choice = sys.argv[1] if len(sys.argv) > 1 else '4'

    if choice == '1':
        asyncio.run(test_upload_image())
    elif choice == '2':
        asyncio.run(test_comment_with_image())
    elif choice == '3':
        asyncio.run(test_comment_without_image())
    elif choice == '4':
        print("\n" + "=" * 50)
        print("运行所有测试")
        print("=" * 50 + "\n")

        print("\n[1/3] 测试图片上传...")
        asyncio.run(test_upload_image())

        print("\n" + "=" * 50 + "\n")

        print("\n[2/3] 测试不带图片的评论发布...")
        asyncio.run(test_comment_without_image())

        print("\n" + "=" * 50 + "\n")

        print("\n[3/3] 测试带图片的评论发布...")
        asyncio.run(test_comment_with_image())

        print("\n" + "=" * 50)
        print("所有测试完成!")
        print("=" * 50)
    else:
        print("无效的选项")
        print("用法: python test_bilibili_comment_with_image.py [1|2|3|4]")
        print("  1: 测试图片上传")
        print("  2: 测试带图片的评论发布")
        print("  3: 测试不带图片的评论发布")
        print("  4: 运行所有测试 (默认)")


if __name__ == '__main__':
    main()
