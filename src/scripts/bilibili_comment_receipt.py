"""Bounded read-only recovery of a top-level comment whose POST receipt was lost."""

import asyncio
import base64
import json
import math
import re
import sys


def match_receipt(rows, uid, text, started_ms, has_image=False):
    """Bind author, exact text, top-level target and a fixed attempt-time window.

    The caller binds the resource via the SDK query. Absence is never proof that
    posting failed: moderation and pagination can hide an accepted comment.
    """
    matches = {}
    normalized = text.replace('\r\n', '\n').strip()
    for row in rows:
        if not isinstance(row, dict):
            continue
        content = row.get('content') or {}
        author = str((row.get('member') or {}).get('mid', ''))
        reply_id = str(row.get('rpid_str') or row.get('rpid') or '')
        stamp = row.get('ctime')
        if (author != uid or not re.fullmatch(r'[1-9][0-9]*', reply_id)
                or str(row.get('root_str') or row.get('root') or '0') != '0'
                or not isinstance(stamp, (int, float)) or not math.isfinite(stamp)
                or not started_ms / 1000 - 5 <= stamp <= started_ms / 1000 + 120
                or str(content.get('message', '')).replace('\r\n', '\n').strip() != normalized):
            continue
        pictures = content.get('pictures') or []
        if bool(pictures) != has_image:
            continue
        receipt = {'replyId': reply_id, 'replyTime': stamp * 1000}
        if pictures and isinstance(pictures[0], dict):
            receipt['imageUrl'] = pictures[0].get('img_src')
        matches[reply_id] = receipt
    return next(iter(matches.values())) if len(matches) == 1 else None


async def find_receipt(read_page, uid, text, started_ms, has_image=False):
    rows = []
    for page in range(1, 4):
        data = await read_page(page)
        replies = data.get('replies') or []
        if not isinstance(replies, list):
            raise ValueError('Invalid comment page')
        rows.extend(replies)
        if not replies:
            break
        total = (data.get('page') or {}).get('count')
        if isinstance(total, int) and len(rows) >= total:
            break
    return match_receipt(rows, uid, text, started_ms, has_image)


async def main(args):
    # Credentials use the existing child-process contract, never model-provided URLs.
    from bilibili_api import comment
    from bilibili_comment import build_credential, get_dynamic_comment_id
    dynamic_id, text, session, csrf, uid, started, image, options = args
    started_ms = float(started)
    if (not re.fullmatch(r'[1-9][0-9]*', dynamic_id) or not re.fullmatch(r'[1-9][0-9]*', uid)
            or not math.isfinite(started_ms) or started_ms <= 0):
        raise ValueError('Invalid receipt lookup identity')
    credential = build_credential(session, csrf, uid, json.loads(base64.b64decode(options)))
    oid, kind = await get_dynamic_comment_id(dynamic_id, credential)
    async def read_page(page):
        return await comment.get_comments(int(oid), kind, page_index=page,
                                          order=comment.OrderType.TIME, credential=credential)
    receipt = await find_receipt(read_page, uid, text, started_ms, image == '1')
    return {'status': 'found', 'receipt': receipt} if receipt else {'status': 'unknown'}


if __name__ == '__main__':
    # Importing the shared credential helper redirects ordinary print to stderr.
    from bilibili_comment import json_print
    try:
        result = asyncio.run(asyncio.wait_for(main(sys.argv[1:]), 25))
    except Exception:
        result = {'status': 'unavailable'}
    json_print(json.dumps(result, ensure_ascii=False))
