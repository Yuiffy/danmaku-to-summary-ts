#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B站评论发布脚本
使用 bilibili-api-python 库处理B站评论功能
"""

import sys
import json
import asyncio
from bilibili_api import comment, Credential
from bilibili_api.comment import CommentResourceType


async def publish_comment(dynamic_id: str, content: str, sessdata: str, bili_jct: str, dedeuserid: str) -> dict:
    """
    发布动态评论

    Args:
        dynamic_id: 动态ID
        content: 评论内容
        sessdata: SESSDATA
        bili_jct: CSRF Token
        dedeuserid: DedeUserID

    Returns:
        dict: 包含评论结果的字典
    """
    try:
        # 创建 Credential 对象
        credential = Credential(
            sessdata=sessdata,
            bili_jct=bili_jct,
            dedeuserid=dedeuserid
        )

        # 验证凭证是否有效
        is_valid = await credential.check_valid()

        if not is_valid:
            return {
                'success': False,
                'error': '凭证无效',
                'message': 'SESSDATA或bili_jct无效，请检查Cookie'
            }

        # 使用 comment.send_comment 函数发送评论
        result = await comment.send_comment(
            text=content,
            oid=int(dynamic_id),
            type_=CommentResourceType.DYNAMIC,
            credential=credential
        )

        return {
            'success': True,
            'reply_id': str(result.get('rpid', '')),
            'message': '评论发布成功'
        }

    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'message': '评论发布失败'
        }


def main():
    """主函数"""
    # 从命令行参数读取输入
    if len(sys.argv) < 6:
        print(json.dumps({
            'success': False,
            'error': '参数不足',
            'message': '需要参数: dynamic_id content sessdata bili_jct dedeuserid'
        }))
        sys.exit(1)

    dynamic_id = sys.argv[1]
    content = sys.argv[2]
    sessdata = sys.argv[3]
    bili_jct = sys.argv[4]
    dedeuserid = sys.argv[5]

    # 发布评论
    result = asyncio.run(publish_comment(dynamic_id, content, sessdata, bili_jct, dedeuserid))

    # 输出JSON结果
    print(json.dumps(result, ensure_ascii=False))

    # 根据结果设置退出码
    sys.exit(0 if result['success'] else 1)


if __name__ == '__main__':
    main()
