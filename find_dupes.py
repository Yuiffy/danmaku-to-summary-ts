import sys, os, json, requests, time
sys.stdout.reconfigure(line_buffering=True)

PROJECT = r'D:\workspace\myrepo\danmaku-to-summary-ts'
sys.path.insert(0, os.path.join(PROJECT, 'src', 'scripts'))
os.chdir(PROJECT)
from config_loader import find_secrets_path

secrets_path = find_secrets_path()
with open(secrets_path, 'r', encoding='utf-8-sig') as f:
    secrets = json.load(f)
cookie_str = secrets.get('bilibili', {}).get('cookie', '')

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Cookie': cookie_str,
    'Referer': 'https://member.bilibili.com/platform/upload/video/frame'
}

# Try member API with different params
all_archives = []
for pn in range(1, 10):
    r = requests.get('https://member.bilibili.com/x/web/archives',
        params={'pn': pn, 'ps': 50},
        headers=headers, timeout=15)
    data = r.json()
    archives = (data.get('data') or {}).get('archives') or []
    if not archives:
        break
    all_archives.extend(archives)
    print(f'pn={pn}: got {len(archives)}')
    time.sleep(1)

print(f'Total: {len(all_archives)}')

# Also try space API as backup
try:
    r2 = requests.get('https://api.bilibili.com/x/space/wbi/arc/search',
        params={'mid': 412141275, 'pn': 1, 'ps': 50, 'order': 'pubdate'},
        headers={'User-Agent': 'Mozilla/5.0', 'Cookie': cookie_str},
        timeout=15)
    data2 = r2.json()
    vlist = ((data2.get('data') or {}).get('list') or {}).get('vlist') or []
    print(f'\nSpace API: got {len(vlist)} videos')
    for v in vlist:
        all_archives.append({'bvid': v.get('bvid',''), 'title': v.get('title',''), 'pubdate': v.get('created',0), 'state': v.get('state',0)})
except Exception as e:
    print(f'Space API failed: {e}')

# Find all with 小岁 in title
sui = [(a.get('bvid',''), a.get('title',''), a.get('pubdate',0), a.get('state',0)) for a in all_archives if '小岁' in a.get('title','')]
sui.sort(key=lambda x: x[2], reverse=True)

print(f'\n=== All 【小岁】 clips ({len(sui)} total) ===')
from collections import Counter
title_count = Counter(t for _, t, _, _ in sui)

for bvid, title, ts, state in sui:
    state_str = '' if state == 0 else f' [state={state}]'
    dup = '🔁DUP' if title_count[title] > 1 else ''
    print(f'  {bvid} | {title}{state_str} {dup}')

# List duplicates explicitly
dupes = {t: [] for _, t, _, _ in sui if title_count[t] > 1}
for bvid, title, ts, state in sui:
    if title in dupes:
        dupes[title].append(bvid)

if dupes:
    print(f'\n=== DUPLICATE GROUPS ({len(dupes)}) ===')
    for title, bvids in dupes.items():
        print(f'  "{title}"')
        for b in bvids:
            print(f'    -> {b}')
