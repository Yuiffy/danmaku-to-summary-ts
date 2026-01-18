#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验证评论是否发布成功
"""

import sys
import asyncio
from bilibili_api import comment, Credential, dynamic
from bilibili_api.comment import CommentResourceType

Dynamic = dynamic.Dynamic


async def verify_comment(dynamic_id: str, reply_id: str, sessdata: str, bili_jct: str, dedeuserid: str):
    """
    验证评论是否发布成功

    Args:
        dynamic_id: 动态ID
        reply_id: 回复ID
        sessdata: SESSDATA
        bili_jct: CSRF Token
        dedeuserid: DedeUserID
    """
    print(f"=== 验证评论 ===")
    print(f"动态ID: {dynamic_id}")
    print(f"回复ID: {reply_id}\n")

    try:
        # 创建凭证对象
        credential = Credential(
            sessdata=sessdata,
            bili_jct=bili_jct,
            dedeuserid=dedeuserid
        )

        # 验证凭证是否有效
        is_valid = await credential.check_valid()
        print(f"凭证验证结果: {'有效' if is_valid else '无效'}")

        if not is_valid:
            print("凭证无效，请检查Cookie")
            return

        # 获取动态的comment_id和评论类型
        dynamic_obj = Dynamic(dynamic_id=int(dynamic_id), credential=credential)
        info = await dynamic_obj.get_info()

        item = info.get('item', {})
        basic = item.get('basic', {})
        comment_id_str = basic.get('comment_id_str', '')
        comment_type = basic.get('comment_type', 11)

        print(f"动态comment_id: {comment_id_str}")
        print(f"动态comment_type: {comment_type}")

        # 根据comment_type映射到CommentResourceType
        if comment_type == 11:
            comment_resource_type = CommentResourceType.DYNAMIC_DRAW
        elif comment_type == 17:
            comment_resource_type = CommentResourceType.DYNAMIC
        elif comment_type == 12:
            comment_resource_type = CommentResourceType.ARTICLE
        else:
            comment_resource_type = CommentResourceType.DYNAMIC_DRAW

        print(f"评论资源类型: {comment_resource_type.value}")

        # 获取评论列表
        print(f"\n获取评论列表...")
        comments = await comment.get_comments(
            oid=int(comment_id_str),
            type_=comment_resource_type,
            credential=credential
        )

        replies = comments.get('replies', [])
        print(f"评论数量: {len(replies)}")

        # 查找指定的回复
        found = False
        for reply in replies:
            if str(reply.get('rpid', '')) == reply_id:
                found = True
                print(f"\n=== 找到评论 ===")
                print(f"回复ID: {reply.get('rpid')}")
                print(f"内容: {reply.get('content', {}).get('message', '')}")
                print(f"用户: {reply.get('member', {}).get('uname', '')}")
                print(f"时间: {reply.get('ctime', '')}")
                break

        if not found:
            print(f"\n=== 未找到评论 ===")
            print(f"回复ID {reply_id} 不在评论列表中")
            print(f"\n前5条评论:")
            for i, reply in enumerate(replies[:5]):
                print(f"{i+1}. 回复ID: {reply.get('rpid')}, 内容: {reply.get('content', {}).get('message', '')[:50]}")

    except Exception as e:
        print(f"验证失败: {e}")
        import traceback
        traceback.print_exc()


def main():
    """主函数"""
    if len(sys.argv) < 6:
        print("用法: python test_verify_comment.py <dynamic_id> <reply_id> <sessdata> <bili_jct> <dedeuserid>")
        sys.exit(1)

    dynamic_id = sys.argv[1]
    reply_id = sys.argv[2]
    sessdata = sys.argv[3]
    bili_jct = sys.argv[4]
    dedeuserid = sys.argv[5]

    asyncio.run(verify_comment(dynamic_id, reply_id, sessdata, bili_jct, dedeuserid))


if __name__ == '__main__':
    main()
