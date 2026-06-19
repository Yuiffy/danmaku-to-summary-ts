import sys, os, json, requests
sys.path.insert(0, os.path.join('src', 'scripts'))
from config_loader import get_config, find_secrets_path
config = get_config()
secrets_path = find_secrets_path()
with open(secrets_path, 'r', encoding='utf-8') as f:
    secrets = json.load(f)
cookie_str = secrets.get('bilibili', {}).get('cookie', '')

headers = {
    'User-Agent': 'Mozilla/5.0',
    'Cookie': cookie_str,
    'Referer': 'https://member.bilibili.com'
}
r = requests.get('https://member.bilibili.com/x/web/archives', params={'pn': 1, 'ps': 50}, headers=headers, timeout=15)
data = r.json()
data_obj = data.get('data') or {}
archives = data_obj.get('archives') or []
print(f'API code: {data.get("code")} msg: {data.get("message")}')
print(f'Archives count in response: {len(archives)}')
for a in archives:
    title = a.get('title', '')[:60]
    bvid = a.get('bvid', '')
    print(f'{bvid} | {title}')
page_info = data.get('data', {}).get('page', {})
total = page_info.get('count', '?')
print(f'Total archives: {total}')
