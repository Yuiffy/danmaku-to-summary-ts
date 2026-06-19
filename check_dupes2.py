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

# Parse cookies
cookies_dict = {}
for item in cookie_str.split(';'):
    item = item.strip()
    if '=' in item:
        k, v = item.split('=', 1)
        cookies_dict[k.strip()] = v.strip()

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Cookie': cookie_str,
    'Referer': 'https://member.bilibili.com/platform/upload/video/frame'
}

# Try the Studio API
r = requests.get('https://member.bilibili.com/x/web/stock/search', 
    params={'pn': 1, 'ps': 30, 'order': 'pubdate'},
    headers=headers, timeout=15)
print(f'Stock search status={r.status_code} text={r.text[:200]}')

# Try arc/search
r2 = requests.get('https://member.bilibili.com/x/web/archives',
    params={'pn': 1, 'ps': 30, 'order': 'pubdate', 'tid': 0},
    headers=headers, timeout=15)
data2 = r2.json()
print(f'Archives with order: code={data2.get("code")} msg={data2.get("message")}')
arc_data = data2.get('data') or {}
archives = arc_data.get('archives') or []
print(f'Got {len(archives)} archives')

# Try arc/relation API  
r3 = requests.get('https://api.bilibili.com/x/space/arc/search',
    params={'mid': 412141275, 'pn': 1, 'ps': 30, 'order': 'pubdate'},
    headers={'User-Agent': 'Mozilla/5.0', 'Cookie': cookie_str},
    timeout=15)
data3 = r3.json()
print(f'Arc search: code={data3.get("code")} msg={data3.get("message")}')
vlist = ((data3.get('data') or {}).get('list') or {}).get('vlist') or []
print(f'Got {len(vlist)} videos from space API')
for v in vlist[:10]:
    print(f'  {v.get("bvid","")} | {v.get("title","")[:50]} | date={v.get("created","")}')
