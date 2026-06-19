import sys, os, json, asyncio
sys.stdout.reconfigure(line_buffering=True)
sys.path.insert(0, os.path.join(os.getcwd(), 'src', 'scripts'))
from bilibili_upload import build_credential
from bilibili_api import video

KNOWN_BVIDS = [
    'BV1Cqjh6KEzC', 'BV1Wnje6yEoD', 'BV1Wnje6yED9', 'BV1Wnje6yEXC',
]

# Also check recent clips by trying sequential BV patterns around known ones
# B站 BV号是 base58 编码，相近的投稿可能 BV 号也相近
# We'll check the 4 known ones first, then try to find their neighbors

async def check_bvid(bv, cred):
    try:
        v = video.Video(bvid=bv, credential=cred)
        info = await v.get_info()
        title = info.get('title', '')
        state = info.get('state', 0)
        pubdate = info.get('pubdate', 0)
        aid = info.get('aid', 0)
        print(f'{bv} | aid={aid} | state={state} | {title}')
        return {'bvid': bv, 'title': title, 'state': state, 'aid': aid, 'pubdate': pubdate}
    except Exception as e:
        err = str(e)[:100]
        print(f'{bv} | ERROR: {err}')
        return None

async def main():
    cred = build_credential()
    print('=== Checking known BV numbers ===')
    results = []
    for bv in KNOWN_BVIDS:
        r = await check_bvid(bv, cred)
        if r:
            results.append(r)
    
    # The 4 known BVs all start with BV1Cq or BV1Wn
    # The parallel attempts may have created videos with nearby BVids
    # But we can't guess BV numbers. Let's try the member API differently.
    
    print('\n=== Trying member API with cookie debug ===')
    import requests
    secrets_path = os.path.join(os.getcwd(), 'config', 'secret.json')
    if not os.path.exists(secrets_path):
        # try alternate path
        for p in ['config/secret.json', 'config/production.json']:
            if os.path.exists(p):
                print(f'Found: {p}')
    # Check what cookies we have
    from config_loader import find_secrets_path
    sp = find_secrets_path()
    print(f'Secrets path: {sp}')
    with open(sp, 'r', encoding='utf-8-sig') as f:
        secrets = json.load(f)
    cookie_str = secrets.get('bilibili', {}).get('cookie', '')
    # Extract key cookie values
    for part in cookie_str.split(';'):
        part = part.strip()
        if any(k in part for k in ['DedeUserID', 'SESSDATA', 'bili_jct']):
            k, v = part.split('=', 1)
            print(f'  {k} = {v[:20]}...')

asyncio.run(main())
