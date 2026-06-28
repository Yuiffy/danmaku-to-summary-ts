#!/usr/bin/env python
"""用 bilibili-api VideoEditor 改标题"""
import json, sys, time, requests, asyncio
sys.path.insert(0, 'src/scripts')
from config_loader import find_secrets_path
from bilibili_api import Credential, video_uploader

secrets_path = find_secrets_path()
with open(secrets_path, 'r', encoding='utf-8-sig') as f:
    secrets = json.load(f)
cookie_str = secrets.get('bilibili', {}).get('cookie', '')

cookies = {}
for item in cookie_str.split(';'):
    item = item.strip()
    if '=' in item:
        k, v = item.split('=', 1)
        cookies[k.strip()] = v.strip()

cred = Credential(
    sessdata=cookies.get('SESSDATA', ''),
    bili_jct=cookies.get('bili_jct', ''),
    buvid3=cookies.get('buvid3', ''),
    dedeuserid=cookies.get('DedeUserID', '412141275'),
    ac_time_value=cookies.get('ac_time_value', ''),
)

headers = {'Cookie': cookie_str, 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://member.bilibili.com/'}

# Fetch all archives
all_archives = []
for pn in range(1, 6):
    r = requests.get('https://member.bilibili.com/x/web/archives',
                     params={'mid': 412141275, 'pn': pn, 'ps': 30, 'typeid': 0, 'status': -1},
                     headers=headers, timeout=15)
    data = r.json()
    if data.get('code') != 0:
        break
    audits = (data.get('data') or {}).get('arc_audits') or []
    if not audits:
        break
    all_archives.extend(audits)

needs_edit = []
for a in all_archives:
    arc = a.get('Archive', {})
    title = arc.get('title', '')
    bvid = arc.get('bvid', '')
    state = arc.get('state', 0)
    if '岁己' in title and state >= 0:
        needs_edit.append({'bvid': bvid, 'old_title': title, 'new_title': title.replace('岁己', '小岁')})

print(f"Total: {len(all_archives)}, 需要改: {len(needs_edit)}\n")

async def edit_title(bvid, new_title):
    # Step 1: fetch existing config
    r = requests.get('https://member.bilibili.com/x/vupre/web/archive/view',
                     params={'bvid': bvid, 'topic_grey': 1},
                     headers={**headers, 'Cookie': cookie_str},
                     timeout=15)
    d = r.json().get('data', {})
    archive = d.get('archive', {})
    videos = d.get('videos', [])

    # Build meta exactly as bilibili-api VideoEditor does
    meta = {
        'title': new_title,
        'copyright': archive.get('copyright', 2),
        'source': archive.get('source', ''),
        'tid': archive.get('tid', 21),
        'tag': archive.get('tag', ''),
        'desc_format_id': archive.get('desc_format_id', 9999),
        'desc': archive.get('desc', ''),
        'dynamic': archive.get('dynamic', ''),
        'interactive': 0,
        'new_web_edit': 1,
        'act_reserve_create': 0,
        'handle_staff': False,
        'topic_grey': 1,
        'no_reprint': archive.get('no_reprint', 0),
        'subtitles': {'lan': '', 'open': 0},
        'web_os': 1,
        'cover': archive.get('cover', '').replace('http://', 'https://'),
        'videos': [],
        'aid': archive.get('aid'),
    }

    for v in videos:
        meta['videos'].append({
            'title': v.get('title', ''),
            'desc': v.get('desc', ''),
            'filename': v.get('filename', ''),
            'cid': v.get('cid', 0),
        })

    # Step 2: submit edit via raw API
    meta['csrf'] = cookies.get('bili_jct', '')

    r2 = requests.post(
        'https://member.bilibili.com/x/vu/web/edit',
        headers={**headers, 'Content-Type': 'application/json;charset=UTF-8',
                 'Cookie': cookie_str},
        json=meta,
        params={'csrf': cookies.get('bili_jct', ''), 't': int(time.time() * 1000)},
        timeout=15,
    )
    resp = r2.json()
    return resp

success = 0
fail = 0
for item in needs_edit:
    bvid = item['bvid']
    new_title = item['new_title']
    print(f"  {bvid} | → {new_title[:60]}")

    try:
        resp = asyncio.run(edit_title(bvid, new_title))
        if resp.get('code') == 0:
            print(f"    ✅")
            success += 1
        else:
            print(f"    ❌ code={resp.get('code')} msg={resp.get('message','')[:80]}")
            fail += 1
    except Exception as e:
        print(f"    ❌ {str(e)[:100]}")
        fail += 1

    time.sleep(2)

print(f"\n完成！成功 {success} | 失败 {fail}")
