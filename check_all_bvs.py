"""Check all 10 BVs to find which are duplicates and their states.
Search results (visible): BV1kBjh6vEB2, BV1Wnje6yE2j, BV1Cqjh6KEGQ, BV1Cqjh6KEHE, BV1Wnje6yEr1, BV1Wnje6yENA
Our records (state=-50): BV1Cqjh6KEzC, BV1Wnje6yEoD, BV1Wnje6yED9, BV1Wnje6yEXC"""
import asyncio, sys, os, json
sys.stdout.reconfigure(line_buffering=True)
sys.path.insert(0, os.path.join(os.getcwd(), 'src', 'scripts'))
from bilibili_upload import build_credential
from bilibili_api import video

ALL_BVIDS = [
    # Search results (visible to public)
    'BV1kBjh6vEB2',  # 男生腿
    'BV1Wnje6yE2j',  # 代可可脂
    'BV1Cqjh6KEGQ',  # 弹幕兄弟
    'BV1Cqjh6KEHE',  # 一只手套
    'BV1Wnje6yEr1',  # 人体工学椅
    'BV1Wnje6yENA',  # 吹笛子
    # Our recorded BVs (state=-50)
    'BV1Cqjh6KEzC',  # 男生腿 (our record)
    'BV1Wnje6yEoD',  # 代可可脂 (our record)
    'BV1Wnje6yED9',  # 弹幕兄弟 (our record)
    'BV1Wnje6yEXC',  # 一只手套 (our record)
]

STATE_MAP = {
    0: '正常/公开',
    1: '审核中',
    -1: '审核失败',
    -2: '审核退回',
    -3: '审核中',
    -4: '被删除',
    -5: '管理员删除',
    -6: '管理员删除',
    -16: '审核中',
    -50: '审核退回(重复?)',
    -100: '删除',
}

async def main():
    cred = build_credential()
    results = []
    for bv in ALL_BVIDS:
        try:
            v = video.Video(bvid=bv)
            info = await v.get_info()
            state = info.get('state', 0)
            state_str = STATE_MAP.get(state, f'未知({state})')
            title = info.get('title', '')
            aid = info.get('aid', 0)
            pubdate = info.get('pubdate', 0)
            import datetime
            dt = datetime.datetime.fromtimestamp(pubdate).strftime('%H:%M:%S') if pubdate else '?'
            print(f'{bv} | aid={aid} | {dt} | state={state}({state_str}) | {title}')
            results.append({'bvid': bv, 'aid': aid, 'title': title, 'state': state, 'pubdate': pubdate})
        except Exception as e:
            err = str(e)[:150]
            print(f'{bv} | ERROR: {err}')
        await asyncio.sleep(0.5)
    
    # Group by title
    print('\n=== GROUPED BY TITLE ===')
    from collections import defaultdict
    groups = defaultdict(list)
    for r in results:
        groups[r['title']].append(r)
    
    for title, items in groups.items():
        if len(items) > 1:
            print(f'\n🔴 DUP: {title}')
            for i in items:
                s = STATE_MAP.get(i['state'], str(i['state']))
                print(f'   {i["bvid"]} | state={i["state"]}({s})')
        else:
            i = items[0]
            s = STATE_MAP.get(i['state'], str(i['state']))
            print(f'✅ {i["bvid"]} | {s} | {title}')

asyncio.run(main())
