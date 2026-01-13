#!/usr/bin/env python3
"""
修复Python脚本中的Unicode字符，避免Windows命令行编码问题
"""

import os
import re

def fix_unicode_in_file(filepath):
    """修复文件中的Unicode字符"""
    print(f"处理文件: {filepath}")
    
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 替换Unicode字符为文本
    replacements = {
        '❌': '[ERROR]',
        '✅': '[OK]',
        '⚠️': '[WARNING]',
        'ℹ️': '[INFO]',
        '🎨': '[ART]',
        '📸': '[CAMERA]',
        '⏳': '[WAIT]',
        '📥': '[DOWNLOAD]',
        '🖼️': '[IMAGE]',
        '📄': '[FILE]',
        '🏠': '[ROOM]',
        '🔍': '[SEARCH]',
        '💥': '[EXPLOSION]',
        '🤖': '[ROBOT]',
        '🐍': '[PYTHON]',
        '📖': '[BOOK]',
        '🎉': '[CELEBRATE]',
        '📊': '[CHART]',
        '📁': '[FOLDER]',
        '📋': '[CLIPBOARD]',
        '🚀': '[ROCKET]',
        '🎯': '[TARGET]',
        '⚡': '[ZAP]',
        '🛠️': '[TOOLS]',
        '🔧': '[WRENCH]',
        '📈': '[GRAPH_UP]',
        '📉': '[GRAPH_DOWN]',
        '🔥': '[FIRE]',
        '💬': '[SPEECH]',
        '▫️': '[DOT]',
        '🌙': '[MOON]',
        '☀️': '[SUN]',
        '🍪': '[COOKIE]',
        '💝': '[GIFT]',
        '🌟': '[STAR]',
        '😂': '[LAUGH]',
        '🎮': '[GAME]',
        '🎵': '[MUSIC]',
        '💝': '[GIFT]',
        '💬': '[CHAT]',
        '📝': '[NOTE]',
        '🎨': '[ART]',
        '📐': '[RULER]',
    }
    
    # 使用正则表达式替换所有匹配的Unicode字符
    for unicode_char, text_replacement in replacements.items():
        content = content.replace(unicode_char, text_replacement)
    
    # 写入修复后的内容
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print(f"  完成修复，替换了 {len(replacements)} 种Unicode字符")

def main():
    # 修复ai_comic_generator.py
    script_path = os.path.join(os.path.dirname(__file__), 'ai_comic_generator.py')
    if os.path.exists(script_path):
        fix_unicode_in_file(script_path)
    else:
        print(f"文件不存在: {script_path}")
    
    print("\n修复完成！现在Python脚本应该可以在Windows命令行中正常运行。")

if __name__ == "__main__":
    main()