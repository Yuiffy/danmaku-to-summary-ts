import requests, json, sys
sys.path.insert(0, r'D:\workspace\myrepo\danmaku-to-summary-ts\src\scripts')
from config_loader import find_secrets_path

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
csrf = cookies.get('bili_jct', '')

H = {
    'Cookie': cookie_str,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://member.bilibili.com/x2/creative/web/season?id=8513688',
    'Accept': 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
}

aid1 = 116878643042446

urls = [
    'https://api.bilibili.com/x/series/season/addArchive',
    'https://api.bilibili.com/x/series/season/addArchives',
    'https://api.bilibili.com/x/polymer/web-season/addArchive',
    'https://api.bilibili.com/x/polymer/season/addArchive',
    'https://api.bilibili.com/x/series/series/addArchives',  # 旧版，但用 season_id
]

for url in urls:
    data = {'season_id': 8513688, 'aid': aid1, 'aids': aid1, 'csrf': csrf}
    try:
        r = requests.post(url, data=data, headers=H, timeout=10)
        try:
            d = r.json()
            code = d.get('code')
            msg = d.get('message')
            print('POST %s: %s code=%s msg=%s' % (url, r.status_code, code, msg))
        except:
            print('POST %s: %s (non-json)' % (url, r.status_code))
    except Exception as e:
        print('%s: ERROR %s' % (url, e))
