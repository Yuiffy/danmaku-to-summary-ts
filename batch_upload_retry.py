"""
Retry upload for clips that got 406.
Done: 1-4. Pending: 5-18.
Sequential, 10s delay between each.
"""
import sys, os, json, asyncio, time

sys.stdout.reconfigure(line_buffering=True)

PROJECT = r'D:\workspace\myrepo\danmaku-to-summary-ts'
sys.path.insert(0, os.path.join(PROJECT, 'src', 'scripts'))
os.chdir(PROJECT)

from bilibili_upload import upload_video, build_credential

CLIPS_DIR = r'D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_18\own_stream_fun_clips'
SOURCE_DESC = '岁己SUI 直播《悠哉悠哉夜晚》2026-06-18'
TAGS = ['小岁', '虚拟主播', '直播切片', '岁AI切片']

DONE = {1: 'BV1Cqjh6KEzC', 2: 'BV1Wnje6yEoD', 3: 'BV1Wnje6yED9', 4: 'BV1Wnje6yEXC'}

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

def get_filename(idx, start_time):
    return f'录制-25788785-20260618-195202-513-悠哉悠哉夜晚_merged_fun_{idx:02d}_{start_time.replace(":", "")}.mp4'

def format_desc(clip_title, start_str, dur_str):
    parts = dur_str.split(':')
    dur_sec = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    sparts = start_str.split(':')
    start_sec = int(sparts[0]) * 3600 + int(sparts[1]) * 60 + int(sparts[2])
    end_sec = start_sec + dur_sec
    def s2str(s):
        h=s//3600; m=(s%3600)//60; s=s%60
        return f'{h:02d}:{m:02d}:{s:02d}'
    return f"直播切片\n{clip_title}\n\n来源：{SOURCE_DESC}\n切片时间：{start_str} - {s2str(end_sec)}（直播开始后第{start_sec//60}分钟）\n\n来源：{SOURCE_DESC}"

async def main():
    credential = build_credential()
    print(f'Already done: {list(DONE.keys())}')
    
    results = []
    consecutive_406 = 0
    
    for idx, title_text, start_str, dur_str in CLIPS:
        full_title = f'【小岁】{title_text}'
        filename = get_filename(idx, start_str)
        filepath = os.path.join(CLIPS_DIR, filename)
        
        if not os.path.exists(filepath):
            print(f'[{idx}] SKIP (no file)')
            continue
        
        desc = format_desc(title_text, start_str, dur_str)
        size_mb = os.path.getsize(filepath) / (1024 * 1024)
        print(f'[{idx}/18] Uploading: {full_title} ({size_mb:.1f} MB)')
        
        try:
            result = await upload_video(
                video_path=filepath,
                title=full_title,
                desc=desc,
                tags=TAGS,
                tid=21,
                credential=credential
            )
            if result and isinstance(result, dict) and result.get('bvid'):
                bvid = result['bvid']
                print(f'  ✅ {bvid}')
                results.append({'idx': idx, 'title': full_title, 'status': 'ok', 'bvid': bvid})
                DONE[idx] = bvid
                consecutive_406 = 0
            else:
                print(f'  ❓ No bvid')
                results.append({'idx': idx, 'title': full_title, 'status': 'check'})
                consecutive_406 += 1
        except Exception as e:
            err = str(e)
            if '406' in err:
                consecutive_406 += 1
                print(f'  ❌ 406 (consecutive: {consecutive_406})')
                results.append({'idx': idx, 'title': full_title, 'status': '406'})
                # If 3 consecutive 406s, stop - we're rate limited
                if consecutive_406 >= 3:
                    print(f'  ⛔ 3 consecutive 406s, stopping. Will retry later.')
                    break
            else:
                print(f'  ❌ {err[:200]}')
                results.append({'idx': idx, 'title': full_title, 'status': 'error', 'error': err[:200]})
                consecutive_406 = 0
        
        # 10s delay
        await asyncio.sleep(10)
    
    # Save results
    results_path = os.path.join(CLIPS_DIR, 'upload_results_retry.json')
    with open(results_path, 'w', encoding='utf-8') as f:
        json.dump({'done': DONE, 'results': results}, f, ensure_ascii=False, indent=2)
    
    print(f'\n=== SUMMARY ===')
    ok = sum(1 for r in results if r['status'] == 'ok')
    print(f'Done previously: 4 | New success: {ok} | Total done: {len(DONE)}')
    remaining = [c[0] for c in CLIPS if c[0] not in DONE]
    if remaining:
        print(f'Remaining: {remaining}')
    print(f'Saved to: {results_path}')

if __name__ == '__main__':
    asyncio.run(main())
