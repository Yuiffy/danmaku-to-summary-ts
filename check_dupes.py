import sys, os, json, requests
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
    'User-Agent': 'Mozilla/5.0',
    'Cookie': cookie_str,
    'Referer': 'https://member.bilibili.com'
}

# Try multiple status values and pages
all_archives = []
for status in ['pubed', 'is_pubed', 'not_pubed', 'all']:
    for pn in range(1, 6):
        try:
            r = requests.get('https://member.bilibili.com/x/web/archives',
                params={'status': status, 'pn': pn, 'ps': 50},
                headers=headers, timeout=15)
            data = r.json()
            archives = (data.get('data') or {}).get('archives')
            if not archives:
                break
            all_archives.extend(archives)
            print(f'status={status} pn={pn}: got {len(archives)} archives')
        except Exception as e:
            print(f'status={status} pn={pn}: {e}')

# Deduplicate by bvid
seen = {}
for a in all_archives:
    bvid = a.get('bvid', '')
    if bvid and bvid not in seen:
        seen[bvid] = a

print(f'\nTotal unique archives: {len(seen)}')

# Find duplicates by title
from collections import Counter
title_counts = Counter()
title_bvids = {}
for a in seen.values():
    t = a.get('title', '')
    title_counts[t] += 1
    title_bvids.setdefault(t, []).append(a.get('bvid', ''))

dupes = {t: bvids for t, bvids in title_bvids.items() if len(bvids) > 1}
if dupes:
    print(f'\n=== DUPLICATES FOUND ({len(dupes)} titles) ===')
    for t, bvids in dupes.items():
        print(f'  {t}')
        for b in bvids:
            print(f'    {b}')
else:
    print('\nNo duplicates found.')

# Show recent 小岁 uploads
print(f'\n=== Recent 【小岁】 uploads ===')
sui_clips = [(a.get('bvid',''), a.get('title',''), a.get('pubdate',0)) for a in seen.values() if '小岁' in a.get('title','')]
sui_clips.sort(key=lambda x: x[2], reverse=True)
for bvid, title, ts in sui_clips[:30]:
    print(f'  {bvid} | {title}')
