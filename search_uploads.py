"""Search for all recent uploads by this account via search API"""
import requests, json, sys
sys.stdout.reconfigure(line_buffering=True)

cookie = 'SESSDATA=c2a47459%2C179735401; DedeUserID=412141275;'
headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Cookie': cookie,
    'Referer': 'https://search.bilibili.com'
}

# Search for uploader's recent videos
r = requests.get('https://api.bilibili.com/x/space/wbi/arc/search',
    params={
        'mid': 412141275,
        'pn': 1,
        'ps': 50,
        'order': 'pubdate',
        'platform': 'web',
        'web_location': '1550101',
        'sort': 'pubdate',
    },
    headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookie,
        'Referer': 'https://space.bilibili.com/412141275/video'
    },
    timeout=15)
print(f'Status: {r.status_code}')
try:
    data = r.json()
    print(f'Code: {data.get("code")} Msg: {data.get("message")}')
    vlist = ((data.get('data') or {}).get('list') or {}).get('vlist') or []
    print(f'Got {len(vlist)} videos')
    for v in vlist:
        title = v.get('title', '')
        bvid = v.get('bvid', '')
        created = v.get('created', 0)
        import datetime
        dt = datetime.datetime.fromtimestamp(created).strftime('%m-%d %H:%M') if created else '?'
        print(f'  {bvid} | {dt} | {title}')
except Exception as e:
    print(f'Error: {e}')
    print(f'Response: {r.text[:500]}')
