#!/usr/bin/env python
"""直接调B站 edit API 修改视频简介"""
import json, requests, time

SECRET = 'D:/workspace/myrepo/danmaku-to-summary-ts/config/secret.json'

with open(SECRET, encoding='utf-8-sig') as f:
    cookie = json.load(f)['bilibili']['cookie']

csrf = ''
idx = cookie.find('bili_jct=')
if idx > 0:
    csrf = cookie[idx+9:idx+41]

HEAD = {
    'User-Agent': 'Mozilla/5.0',
    'Cookie': cookie, 'Referer': 'https://member.bilibili.com',
    'Content-Type': 'application/json;charset=UTF-8',
}

def update(bvid, new_desc, new_tag=None, new_title=None):
    r = requests.get(
        'https://member.bilibili.com/x/vupre/web/archive/view',
        params={'bvid': bvid, 'topic_grey': 1}, headers=HEAD)
    data = r.json()
    if data.get('code') != 0:
        print(f'{bvid}: fetch failed {data}')
        return
    dd = data['data']
    archive = dd.get('archive', {})
    videos = dd.get('videos', [])
    
    payload = {
        'aid': archive.get('aid'),
        'title': new_title or archive.get('title', ''),
        'tid': archive.get('tid', 21),
        'tag': new_tag or archive.get('tag', ''),
        'desc': new_desc,
        'desc_format_id': 0,
        'copyright': archive.get('copyright', 2),
        'source': archive.get('source', ''),
        'cover': archive.get('cover', ''),
        'no_reprint': 0,
        'open_elec': 0,
        'up_close_danmu': False,
        'up_close_reply': False,
        'up_selection_reply': False,
        'dynamic': '',
        'interactive': 0,
        'act_reserve_create': 0,
        'origin_state': 0,
        'web_os': 2,
        'new_web_edit': 1,
        'csrf': csrf,
        'videos': videos,
    }
    
    r2 = requests.post(
        f'https://member.bilibili.com/x/vu/web/edit?csrf={csrf}',
        json=payload, headers=HEAD)
    result = r2.json()
    code = result.get('code', -1)
    if code == 0:
        print(f'{bvid}: OK')
    else:
        print(f'{bvid}: FAIL code={code} msg={result.get("message")}')

if __name__ == '__main__':
    update('BV1xw7C6kEWm',
        '米米聊到如果岁己来家里，感觉小岁可能会挺怕家长的，还聊到冷吃兔的话题。\n'
        '\n'
        '直播日期：2026年6月5日\n'
        '场次：早安一会儿\n'
        '切片时间：第02:29:26 ~ 02:30:56\n'
        '现实时间：约10:33 ~ 10:35',
        '米米,岁己,小岁,虚拟主播,直播切片')
    
    time.sleep(2)
    
    update('BV1xw7C6kE5U',
        '南町聊MixUp庆功宴上东爱璃还在忙着安排栞栞和岁己的座位，'
        '被大家拦下来"你就别管了吃你的吧"。\n'
        '\n'
        '直播日期：2026年6月5日\n'
        '场次：孩子们我终于回来了\n'
        '切片时间：第02:20:13 ~ 02:21:12\n'
        '现实时间：约15:30 ~ 15:31',
        '南町Nightin,岁己,栞栞,小岁,虚拟主播,直播切片',
        '南町聊MixUp庆功宴：栞栞和岁己突然被安排座位！')
