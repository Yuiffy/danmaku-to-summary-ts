#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B站评论发布脚本
使用 bilibili-api-python 库处理B站评论功能
"""

import sys
import json
import asyncio
import io
import os
import base64
from bilibili_api import comment, Credential, dynamic
from bilibili_api.comment import CommentResourceType
from bilibili_api.utils.picture import Picture
from bilibili_api import request_settings

Dynamic = dynamic.Dynamic

# 设置wbi重试次数上限，默认为3，增加到10以应对反爬虫
request_settings.set_wbi_retry_times(10)

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

# 日志输出到stderr，JSON结果输出到stdout
def log(*args, **kwargs):
    """日志输出到stderr"""
    message = ' '.join(str(arg) for arg in args)
    try:
        if not _original_stderr.closed:
            _original_stderr.write(message + '\n')
            _original_stderr.flush()
    except (ValueError, OSError, AttributeError):
        pass

# 全局替换内置print函数
print = safe_print


async def get_dynamic_comment_id(dynamic_id: str, credential: Credential) -> tuple[str, CommentResourceType]:
    """
    获取动态的comment_id和评论类型

    Args:
        dynamic_id: 动态ID
        credential: 凭证对象

    Returns:
        tuple: (comment_id, comment_type)
    """
    # 使用bilibili-api的Dynamic类获取动态信息，自动处理wbi签名和重试
    dynamic = Dynamic(dynamic_id=int(dynamic_id), credential=credential)
    info = await dynamic.get_info()

    # 从返回的数据中提取comment_id和major_type
    item = info.get('item', {})
    basic = item.get('basic', {})
    comment_id_str = basic.get('comment_id_str', '')

    # 获取major_type（新方式）
    modules = item.get('modules', {})
    module_dynamic = modules.get('module_dynamic', {})
    major = module_dynamic.get('major', {})
    major_type = major.get('type', '')

    # 后备：如果major_type为空，使用旧方式
    if not major_type:
        comment_type_old = basic.get('comment_type', 11)
        log(f"[INFO] major_type为空，使用旧方式comment_type: {comment_type_old}")
        if comment_type_old == 11:
            comment_resource_type = CommentResourceType.DYNAMIC_DRAW
        elif comment_type_old == 17:
            comment_resource_type = CommentResourceType.DYNAMIC
        elif comment_type_old == 12:
            comment_resource_type = CommentResourceType.ARTICLE
        else:
            comment_resource_type = CommentResourceType.DYNAMIC_DRAW
    else:
        log(f"[INFO] major_type: {major_type}")
        # 根据major_type映射到CommentResourceType
        if major_type == 'MAJOR_TYPE_DRAW':
            comment_resource_type = CommentResourceType.DYNAMIC_DRAW
        elif major_type in ['MAJOR_TYPE_OPUS', 'MAJOR_TYPE_COMMON', 'MAJOR_TYPE_ARCHIVE']:
            comment_resource_type = CommentResourceType.DYNAMIC
        elif major_type == 'MAJOR_TYPE_ARTICLE':
            comment_resource_type = CommentResourceType.ARTICLE
        else:
            comment_resource_type = CommentResourceType.DYNAMIC_DRAW

    return comment_id_str, comment_resource_type


async def publish_comment(dynamic_id: str, content: str, sessdata: str, bili_jct: str, dedeuserid: str, image_path: str = None) -> dict:
    """
    发布动态评论

    Args:
        dynamic_id: 动态ID
        content: 评论内容
        sessdata: SESSDATA
        bili_jct: CSRF Token
        dedeuserid: DedeUserID
        image_path: 图片路径（可选）

    Returns:
        dict: 包含评论结果的字典
    """
    log(f"[INFO] 开始发布评论到动态: {dynamic_id}")
    log(f"[INFO] 评论内容: {content}")
    if image_path:
        log(f"[INFO] 图片路径: {image_path}")

    try:
        # 创建 Credential 对象
        log(f"[INFO] 创建凭证对象...")
        credential = Credential(
            sessdata=sessdata,
            bili_jct=bili_jct,
            dedeuserid=dedeuserid
        )

        # 验证凭证是否有效
        log(f"[INFO] 验证凭证有效性...")
        is_valid = await credential.check_valid()
        log(f"[INFO] 凭证验证结果: {'有效' if is_valid else '无效'}")

        if not is_valid:
            log(f"[ERROR] 凭证无效，SESSDATA或bili_jct无效，请检查Cookie")
            return {
                'success': False,
                'error': '凭证无效',
                'message': 'SESSDATA或bili_jct无效，请检查Cookie'
            }

        # 获取动态的comment_id和评论类型（使用bilibili-api的Dynamic类，自动处理wbi签名）
        log(f"[INFO] 获取动态的comment_id...")
        comment_id, comment_type = await get_dynamic_comment_id(dynamic_id, credential)
        log(f"[INFO] 获取到comment_id: {comment_id}, 评论类型: {comment_type.value}")
        log(f"[INFO] 动态ID: {dynamic_id}")

        # 如果有图片，先上传图片
        pic = None
        image_url = None
        if image_path:
            log(f"[INFO] 开始上传图片...")
            # 使用Picture类从文件加载图片
            pic = Picture.from_file(image_path)
            # 上传图片到B站
            await pic.upload(credential)
            image_url = pic.url
            log(f"[INFO] 图片上传成功，URL: {image_url}")

        # 使用 comment.send_comment 函数发送评论
        log(f"[INFO] 调用B站API发送评论，oid={comment_id}, type={comment_type.value}...")
        log(f"[INFO] 评论内容长度: {len(content)}")
        result = await comment.send_comment(
            text=content,
            oid=int(comment_id),
            type_=comment_type,
            credential=credential,
            pic=pic
        )

        reply_id = str(result.get('rpid', ''))
        log(f"[OK] 评论发布成功，回复ID: {reply_id}")
        log(f"[INFO] 完整返回结果: {result}")

        return {
            'success': True,
            'reply_id': reply_id,
            'image_url': image_url,
            'message': '评论发布成功'
        }

    except Exception as e:
        log(f"[ERROR] 评论发布失败: {e}")
        safe_print_exc()
        return {
            'success': False,
            'error': str(e),
            'message': '评论发布失败'
        }


def main():
    """主函数"""
    try:
        log(f"[INFO] B站评论发布脚本启动")
    except Exception as e:
        # 如果log失败，使用print
        print(f"[INFO] B站评论发布脚本启动 (fallback)", file=sys.stderr)

    # 从命令行参数读取输入
    if len(sys.argv) < 6:
        log(f"[ERROR] 参数不足，需要参数: dynamic_id content sessdata bili_jct dedeuserid [image_path]")
        print(json.dumps({
            'success': False,
            'error': '参数不足',
            'message': '需要参数: dynamic_id content sessdata bili_jct dedeuserid [image_path]'
        }))
        sys.exit(1)

    dynamic_id = sys.argv[1]
    content = sys.argv[2]
    sessdata = sys.argv[3]
    bili_jct = sys.argv[4]
    dedeuserid = sys.argv[5]
    image_path = sys.argv[6] if len(sys.argv) > 6 else None

    try:
        log(f"[INFO] 接收到参数: dynamic_id={dynamic_id}, content_length={len(content)}, has_image={image_path is not None}")
    except Exception as e:
        print(f"[INFO] 接收到参数: dynamic_id={dynamic_id}, content_length={len(content)}, has_image={image_path is not None}", file=sys.stderr)

    # 发布评论
    result = asyncio.run(publish_comment(dynamic_id, content, sessdata, bili_jct, dedeuserid, image_path))

    # 输出JSON结果到stdout（仅JSON，不带日志前缀）
    log(f"[INFO] 输出结果: {json.dumps(result, ensure_ascii=False)}")
    print(json.dumps(result, ensure_ascii=False))

    # 根据结果设置退出码
    exit_code = 0 if result['success'] else 1
    log(f"[INFO] 脚本退出，退出码: {exit_code}")
    sys.exit(exit_code)


if __name__ == '__main__':
    main()
