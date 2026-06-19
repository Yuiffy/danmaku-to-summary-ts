"""Try to find duplicate uploads by checking video info API directly.
We know 4 succeeded. The user says they see 6 different ones + duplicates.
The 406 errors might have actually created videos.
Strategy: check the aids near our known ones."""
import asyncio, sys, os, json
sys.stdout.reconfigure(line_buffering=True)
sys.path.insert(0, os.path.join(os.getcwd(), 'src', 'scripts'))
from bilibili_upload import build_credential
from bilibili_api import video

KNOWN = {
    'BV1Cqjh6KEzC': 116772627812549,
    'BV1Wnje6yEoD': 116772644589856,
    'BV1Wnje6yED9': 116772644589689,
    'BV1Wnje6yEXC': 116772644590039,
}

async def main():
    cred = build_credential()
    
    # The aids are in range ~116772627812549 to ~116772644590039
    # But aids have gaps. Let's try checking each known BV's "neighbors" 
    # by using the video.get_info for related bvids.
    # Actually, let's try the get_related API
    
    # Better approach: check get_videos_by aid range isn't possible.
    # Let's try the search_bili API for our account name
    import requests
    from config_loader import find_secrets_path
    sp = find_secrets_path()
    with open(sp, 'r', encoding='utf-8-sig') as f:
        secrets = json.load(f)
    cookie_str = secrets.get('bilibili', {}).get('cookie', '')
    
    # Try get member info which might include video count
    r = requests.get('https://api.bilibili.com/x/space/acc/info',
        params={'mid': 412141275},
        headers={'User-Agent': 'Mozilla/5.0', 'Cookie': cookie_str},
        timeout=15)
    data = r.json()
    print(f'Space acc info: code={data.get("code")} msg={data.get("message")}')
    if data.get('code') == 0:
        d = data.get('data', {})
        print(f'  Name: {d.get("name")} mid: {d.get("mid")}')
    
    # Try the get_videos_fav or similar
    # Actually, let's try the old reliable: search by keyword
    r2 = requests.get('https://api.bilibili.com/x/web-interface/search/type',
        params={
            'search_type': 'video',
            'keyword': '鹿饼Shikamochi',
            'order': 'pubdate',
            'page': 1,
        },
        headers={'User-Agent': 'Mozilla/5.0', 'Cookie': cookie_str},
        timeout=15)
    data2 = r2.json()
    print(f'\nSearch by keyword: code={data2.get("code")} msg={data2.get("message")}')
    if data2.get('code') == 0:
        results = (data2.get('data') or {}).get('result') or []
        print(f'Got {len(results)} results')
        for item in results[:20]:
            # Clean title of HTML tags
            import re
            title = re.sub(r'<[^>]+>', '', item.get('title', ''))
            bvid = item.get('bvid', '')
            pubdate = item.get('pubdate', 0)
            import datetime
            dt = datetime.datetime.fromtimestamp(pubdate).strftime('%m-%d %H:%M') if pubdate else '?'
            print(f'  {bvid} | {dt} | {title}')

asyncio.run(main())
