"""
Parallel batch upload remaining clips.
Already done: 1-4 (BV1Cqjh6KEzC, BV1Wnje6yEoD, BV1Wnje6yED9, BV1Wnje6yEXC)
Clip 5 got 406 - need to check if it actually uploaded.
Remaining: 5-18 (check 5 first)
Run 5 at a time in parallel.
"""
import sys, os, json, asyncio, subprocess

sys.stdout.reconfigure(line_buffering=True)

PROJECT = r'D:\workspace\myrepo\danmaku-to-summary-ts'
sys.path.insert(0, os.path.join(PROJECT, 'src', 'scripts'))
os.chdir(PROJECT)

CLIPS_DIR = r'D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_18\own_stream_fun_clips'
SOURCE_DESC = '岁己SUI 直播《悠哉悠哉夜晚》2026-06-18'

CLIPS = [
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

DONE = {
    1: 'BV1Cqjh6KEzC',
    2: 'BV1Wnje6yEoD',
    3: 'BV1Wnje6yED9',
    4: 'BV1Wnje6yEXC',
}

def get_filename(idx, start_time):
    return f'录制-25788785-20260618-195202-513-悠哉悠哉夜晚_merged_fun_{idx:02d}_{start_time.replace(":", "")}.mp4'

def format_desc(clip_title, start_str, dur_str):
    parts = dur_str.split(':')
    dur_sec = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    sparts = start_str.split(':')
    start_sec = int(sparts[0]) * 3600 + int(sparts[1]) * 60 + int(sparts[2])
    end_sec = start_sec + dur_sec
    def sec_to_str(s):
        h = s // 3600; m = (s % 3600) // 60; s = s % 60
        return f'{h:02d}:{m:02d}:{s:02d}'
    end_str = sec_to_str(end_sec)
    start_min = start_sec // 60
    return f"直播切片\n{clip_title}\n\n来源：{SOURCE_DESC}\n切片时间：{start_str} - {end_str}（直播开始后第{start_min}分钟）\n\n来源：{SOURCE_DESC}"

async def upload_one(idx, title_text, start_str, dur_str):
    """Upload a single clip via subprocess."""
    full_title = f'【小岁】{title_text}'
    filename = get_filename(idx, start_str)
    filepath = os.path.join(CLIPS_DIR, filename)
    
    if not os.path.exists(filepath):
        print(f'[{idx}] SKIP (file not found): {filename}')
        return {'idx': idx, 'title': full_title, 'status': 'no_file'}
    
    desc = format_desc(title_text, start_str, dur_str)
    size_mb = os.path.getsize(filepath) / (1024 * 1024)
    print(f'[{idx}] Starting: {full_title} ({size_mb:.1f} MB)')
    
    # Run bilibili_upload.py as subprocess
    cmd = [
        sys.executable, os.path.join(PROJECT, 'src', 'scripts', 'bilibili_upload.py'),
        filepath,
        '--title', full_title,
        '--desc', desc,
        '--tags', '小岁,虚拟主播,直播切片,岁AI切片',
        '--source-desc', SOURCE_DESC,
    ]
    
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stdout, _ = await proc.communicate()
    output = stdout.decode('utf-8', errors='replace') if stdout else ''
    
    # Parse BV from output
    bvid = None
    for line in output.split('\n'):
        if 'bvid:' in line and 'N/A' not in line:
            bvid = line.split('bvid:')[-1].strip()
    
    if proc.returncode == 0 or bvid:
        print(f'[{idx}] ✅ {bvid or "unknown"}')
        return {'idx': idx, 'title': full_title, 'status': 'ok', 'bvid': bvid}
    else:
        # 406 might still be success - check output
        print(f'[{idx}] Result (rc={proc.returncode}):\n{output[-500:]}')
        return {'idx': idx, 'title': full_title, 'status': 'check', 'output': output[-500:]}

async def main():
    print(f'Already done: {list(DONE.keys())}')
    print(f'Remaining: {[c[0] for c in CLIPS]}')
    
    # Run in batches of 5 parallel
    BATCH = 5
    results = []
    
    for i in range(0, len(CLIPS), BATCH):
        batch = CLIPS[i:i+BATCH]
        print(f'\n=== Batch {i//BATCH+1}: clips {[c[0] for c in batch]} ===')
        tasks = [upload_one(idx, title, start, dur) for idx, title, start, dur in batch]
        batch_results = await asyncio.gather(*tasks, return_exceptions=True)
        for r in batch_results:
            if isinstance(r, Exception):
                print(f'EXCEPTION: {r}')
                results.append({'status': 'error', 'error': str(r)})
            else:
                results.append(r)
    
    # Summary
    print('\n\n=== FINAL SUMMARY ===')
    for r in sorted(results, key=lambda x: x.get('idx', 0)):
        icon = {'ok': '✅', 'no_file': '⚠️', 'check': '❓', 'error': '❌'}.get(r.get('status'), '?')
        bvid = r.get('bvid', '')
        print(f'  {icon} [{r.get("idx","?")}] {r.get("title","")} {bvid}')
    
    # Save results
    results_path = os.path.join(CLIPS_DIR, 'upload_results_parallel.json')
    with open(results_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f'\nResults saved to: {results_path}')

if __name__ == '__main__':
    asyncio.run(main())
