"""
Batch upload clips to Bilibili.
- Checks existing archives first to avoid duplicates
- Uploads sequentially with delay
- Records BV numbers
"""
import sys, os, json, time, requests, asyncio

# Force unbuffered output
sys.stdout.reconfigure(line_buffering=True)

PROJECT = r'D:\workspace\myrepo\danmaku-to-summary-ts'
sys.path.insert(0, os.path.join(PROJECT, 'src', 'scripts'))
os.chdir(PROJECT)

from config_loader import get_config, find_secrets_path
from bilibili_upload import upload_video, build_credential, ACCOUNT_MID

CLIPS_DIR = r'D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_18\own_stream_fun_clips'
TAGS = ['小岁', '虚拟主播', '直播切片', '岁AI切片']
SOURCE_DESC = '岁己SUI 直播《悠哉悠哉夜晚》2026-06-18'
LIVE_START = '19:52:02'
TID = 21  # 日常

# All 18 clips
CLIPS = [
    (1,  '男生腿像险峻山峰，短裤上班还被前辈当常识提醒', '00:44:48', '00:04:19'),
    (2,  '代可可脂会一直留在体内？岁己越讲越怕，弹幕开始急了', '00:49:10', '00:03:20'),
    (3,  '弹幕把兄弟聊进去了，岁己急喊直播间不是非法之地', '00:55:20', '00:03:08'),
    (4,  '一只手套只买一个鸟嘴，岁己拆完才发现要做两只手', '00:59:10', '00:04:19'),
    (5,  '人体工学椅是骗局吗，岁己只想要软趴趴大屁股椅', '01:06:57', '00:02:19'),
    (6,  '让她吹笛子点歌，结果找不到调开始乱吹B键', '01:10:00', '00:03:03'),
    (7,  '盲盒一拆先闻竖笛，弹幕笑她又笨又努力了', '01:36:40', '00:02:12'),
    (8,  'DLC到底怎么下，岁己折腾半天才发现早装好了', '01:40:04', '00:02:54'),
    (9,  '班桥被汉化成古风小生，岁己当场嫌翻译太离谱', '01:51:23', '00:01:32'),
    (10, '我没有switch我就告任天堂，岁己吐槽DLC还用AI翻译', '01:54:51', '00:02:36'),
    (11, '恐龙居然还能爆，岁己下湖找鱼一路聊到甲烷臭味', '01:58:08', '00:02:06'),
    (12, '拉稀摆蛋到底啥意思，岁己拿晾被子当例子越讲越损', '02:11:01', '00:03:15'),
    (13, '不准看大夫起床睡颜，弹幕急到要她独占还吃独食', '02:14:52', '00:00:59'),
    (14, '被大鱼咬着还嘴硬搏一搏，弹幕急喊快跑她偏不放弃', '02:20:11', '00:02:31'),
    (15, '打不了鱼先说神也会犯错，结果只是按错键把弹幕逗笑', '02:23:54', '00:01:21'),
    (16, '中年男人式戳鱼半天不中，还嘴硬懂戴夫吗', '02:29:52', '00:03:24'),
    (17, '一桌鱼做好却没人来，岁己看着食材浪费当场心碎', '02:42:06', '00:03:05'),
    (18, '文学少女聊着聊着开始认同豪宅，弹幕都笑她很怪', '02:46:54', '00:03:04'),
]

def get_filename(idx, start_time):
    return f'录制-25788785-20260618-195202-513-悠哉悠哉夜晚_merged_fun_{idx:02d}_{start_time.replace(":", "")}.mp4'

def check_existing():
    """Check existing archives to avoid duplicates."""
    secrets_path = find_secrets_path()
    with open(secrets_path, 'r', encoding='utf-8-sig') as f:
        secrets = json.load(f)
    cookie_str = secrets.get('bilibili', {}).get('cookie', '')
    headers = {
        'User-Agent': 'Mozilla/5.0',
        'Cookie': cookie_str,
        'Referer': 'https://member.bilibili.com'
    }
    existing_titles = set()
    existing_bvids = {}
    for status in ['pubed', 'is_pubed', 'not_pubed']:
        for pn in range(1, 4):
            try:
                r = requests.get('https://member.bilibili.com/x/web/archives',
                    params={'status': status, 'pn': pn, 'ps': 50},
                    headers=headers, timeout=15)
                data = r.json()
                archives = (data.get('data') or {}).get('archives') or []
                if not archives:
                    break
                for a in archives:
                    existing_titles.add(a.get('title', ''))
                    existing_bvids[a.get('title', '')] = a.get('bvid', '')
            except Exception as e:
                print(f'  [WARN] query status={status} pn={pn} failed: {e}')
    return existing_titles, existing_bvids

def format_desc(clip_title, start_str, dur_str):
    """Build video description."""
    # Parse duration
    parts = dur_str.split(':')
    dur_sec = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    # Parse start
    sparts = start_str.split(':')
    start_sec = int(sparts[0]) * 3600 + int(sparts[1]) * 60 + int(sparts[2])
    # End time
    end_sec = start_sec + dur_sec
    def sec_to_str(s):
        h = s // 3600
        m = (s % 3600) // 60
        s = s % 60
        return f'{h:02d}:{m:02d}:{s:02d}'
    end_str = sec_to_str(end_sec)
    start_min = start_sec // 60
    
    desc = f"""直播切片
{clip_title}

来源：{SOURCE_DESC}
切片时间：{start_str} - {end_str}（直播开始后第{start_min}分钟）"""
    return desc

async def main():
    # Check existing
    print('=== Checking existing archives ===')
    existing_titles, existing_bvids = check_existing()
    print(f'Found {len(existing_titles)} existing archives')
    
    # Build credential
    credential = build_credential()
    print('[INFO] Credential created')
    
    results = []
    
    for idx, title, start_str, dur_str in CLIPS:
        full_title = f'【小岁】{title}'
        filename = get_filename(idx, start_str)
        filepath = os.path.join(CLIPS_DIR, filename)
        
        # Check duplicate
        if full_title in existing_titles:
            bvid = existing_bvids.get(full_title, '?')
            print(f'\n[{idx}/18] SKIP (exists): {full_title} -> {bvid}')
            results.append({'idx': idx, 'title': full_title, 'status': 'skip', 'bvid': bvid})
            continue
        
        # Check file exists
        if not os.path.exists(filepath):
            print(f'\n[{idx}/18] SKIP (file not found): {filepath}')
            results.append({'idx': idx, 'title': full_title, 'status': 'no_file'})
            continue
        
        desc = format_desc(title, start_str, dur_str)
        size_mb = os.path.getsize(filepath) / (1024 * 1024)
        print(f'\n[{idx}/18] Uploading: {full_title}')
        print(f'  File: {filename} ({size_mb:.1f} MB)')
        
        try:
            result = await upload_video(
                video_path=filepath,
                title=full_title,
                desc=desc + '\n\n来源：' + SOURCE_DESC,
                tags=TAGS,
                tid=TID,
                credential=credential,
            )
            if result and isinstance(result, dict):
                bvid = result.get('bvid', '')
                print(f'  ✅ Success: {bvid}')
                results.append({'idx': idx, 'title': full_title, 'status': 'ok', 'bvid': bvid})
                existing_titles.add(full_title)
            else:
                print(f'  ❌ Upload returned falsy')
                results.append({'idx': idx, 'title': full_title, 'status': 'fail'})
        except Exception as e:
            print(f'  ❌ Error: {e}')
            results.append({'idx': idx, 'title': full_title, 'status': 'error', 'error': str(e)})
        
        # Wait between uploads (60 seconds, not too fast)
        if idx < len(CLIPS):
            print(f'  Waiting 60s before next upload...')
            await asyncio.sleep(60)
    
    # Summary
    print('\n\n=== SUMMARY ===')
    ok = sum(1 for r in results if r['status'] == 'ok')
    skip = sum(1 for r in results if r['status'] == 'skip')
    fail = sum(1 for r in results if r['status'] in ('fail', 'error', 'no_file'))
    print(f'Success: {ok} | Skipped: {skip} | Failed: {fail}')
    for r in results:
        status_icon = {'ok': '✅', 'skip': '⏭️', 'fail': '❌', 'error': '❌', 'no_file': '⚠️'}.get(r['status'], '?')
        bvid = r.get('bvid', '')
        print(f'  {status_icon} [{r["idx"]}] {r["title"]} {f"-> {bvid}" if bvid else ""}')
    
    # Save results to file
    results_path = os.path.join(CLIPS_DIR, 'upload_results.json')
    with open(results_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f'\nResults saved to: {results_path}')

if __name__ == '__main__':
    asyncio.run(main())
