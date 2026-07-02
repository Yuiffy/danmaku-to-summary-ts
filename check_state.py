import requests, json, sys, os
sys.path.insert(0, os.path.join('src', 'scripts'))
from config_loader import find_secrets_path
with open(find_secrets_path(), 'r', encoding='utf-8-sig') as f:
    secrets = json.load(f)
cookie_str = secrets['bilibili']['cookie']
headers = {'User-Agent': 'Mozilla/5.0', 'Cookie': cookie_str}
r = requests.get('https://api.bilibili.com/x/web-interface/view', params={'bvid': 'BV1m3Th6DEoR'}, headers=headers, timeout=15)
d = r.json()
if d.get('code') == 0:
    print(f'BV1m3Th6DEoR state={d["data"]["state"]} title={d["data"]["title"][:50]}')
else:
    print(f'BV1m3Th6DEoR code={d.get("code")} (may be private now)')
