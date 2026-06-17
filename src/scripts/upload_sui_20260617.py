#!/usr/bin/env python
"""
批量上传岁己2026-06-17空洞骑士切片到B站
- 不分批：B站限制是「最多同时审核10个」，不是上传频率
- 一口气全传，不自动重试
"""
import sys
import os
import json
import asyncio
import subprocess

project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(project_root, 'src', 'scripts'))

from config_loader import find_secrets_path
from bilibili_api import Credential, video_uploader, Picture

DEFAULT_TID = 21
ACCOUNT_MID = 412141275
CLIPS_DIR = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_17\own_stream_fun_clips"
TAGS = ["小岁", "虚拟主播", "直播切片", "岁AI切片"]
SOURCE_DESC = "岁己SUI 直播《摸鱼！空洞骑士~》2026-06-17"

# 18个切片信息 (title, suffix)
CLIPS = [
    ("醒来感觉浑身舒爽以为才十点，一看手机已经两点过，这逻辑给弹幕整笑了", "fun_01_000557"),
    ("为了不让妈妈发现自己没吃饭，竟然要把菜翻炒搅拌伪装现场，这就是顶级智斗吗", "fun_02_001348"),
    ("没装护符就开始锐评没变化，甚至自诩聪明能感受到真理，弹幕笑疯了", "fun_03_005110"),
    ("快速聚集是我的命根子！嘴硬不带幼虫之歌，下一秒就被弹幕无情拆穿", "fun_04_005331"),
    ("刚拿完日记就瞬间失忆？这波操作给弹幕看傻了，这就是天才小岁的含金量吗", "fun_05_005848"),
    ("嫌弃法术还没平A伤害高，这就是不升级技能的下场？小笨手现场表演极度狼狈", "fun_06_010053"),
    ("谁是弱者？我是强者！大放厥词要把手下败将打哭，结果被几根刺搞得当场原机", "fun_07_010917"),
    ("一滴血活了一年！走位全靠缘分，甚至连回血时机都找不到，弹幕：害苦小岁了", "fun_08_011929"),
    ("全世界赢最狼狈的人！靠反伤甲刮死BOSS竟还想骗夸，这波连续下劈真的帅吗", "fun_09_012631"),
    ("看地图不看字还点错地方，嘴硬辩解坐中转便宜，弹幕直呼朋友都笑我", "fun_10_013441"),
    ("刚吹完自己跳得精准就速通深渊，这一落千丈的操作把弹幕都看傻了", "fun_11_013726"),
    ("深渊认亲现场却被兄弟包围，操作稀碎还怪没有稳定之体，这也太下头了", "fun_12_014022"),
    ("拿黑冲被机关疯狂针对，好不容易拿到暗影披风还当场按错键，不演了？", "fun_13_014514"),
    ("拿个咖啡回来发现回不去了，在深渊底部迷路还反手怪弹幕误导，饼干岁急了", "fun_14_014940"),
    ("弹幕求着探缺口还要被怼，操作突然流畅却因惯性误坐椅子，老路痴了", "fun_15_020423"),
    ("地图被感染看不清路竟怪图标挡位，岁己这波顶级理解让弹幕彻底急眼了", "fun_16_020819"),
    ("谁说这是最强护符的？岁己发现被骗后当场急眼想给弹幕一鞭子", "fun_17_023329"),
    ("礼物到底是炸我还是扎我，转头又冒出今天是注水日", "fun_18_030049"),
]


def fix_title(title: str) -> str:
    """替换岁己为小岁,加【小岁】前缀"""
    title = title.replace("岁己", "小岁")
    if not title.startswith("【小岁】"):
        title = f"【小岁】{title}"
    return title


def find_video_file(suffix: str) -> str:
    for f in os.listdir(CLIPS_DIR):
        if f.endswith(suffix + ".mp4"):
            return os.path.join(CLIPS_DIR, f)
    return None


def build_credential() -> Credential:
    secrets_path = find_secrets_path()
    with open(secrets_path, 'r', encoding='utf-8-sig') as f:
        secrets = json.load(f)
    cookie_str = secrets.get('bilibili', {}).get('cookie', '')
    if not cookie_str:
        print("[ERROR] 未找到B站Cookie")
        sys.exit(1)
    cookies = {}
    for item in cookie_str.split(';'):
        item = item.strip()
        if '=' in item:
            k, v = item.split('=', 1)
            cookies[k.strip()] = v.strip()
    return Credential(
        sessdata=cookies.get('SESSDATA', ''),
        bili_jct=cookies.get('bili_jct', ''),
        buvid3=cookies.get('buvid3', ''),
        dedeuserid=cookies.get('DedeUserID', str(ACCOUNT_MID)),
        ac_time_value=cookies.get('ac_time_value', ''),
    )


async def upload_one(video_path: str, title: str, credential: Credential) -> dict:
    file_size = os.path.getsize(video_path) / (1024 * 1024)
    print(f"\n{'='*60}")
    print(f"[UPLOAD] {title}")
    print(f"[FILE] {os.path.basename(video_path)} ({file_size:.1f}MB)")

    desc = "直播切片\n\n来源：" + SOURCE_DESC

    page = video_uploader.VideoUploaderPage(
        path=video_path,
        title=title,
        description=desc,
    )

    cover_tmp = os.path.join(CLIPS_DIR, '_tmp_cover.jpg')
    cover = None
    try:
        subprocess.run([
            'ffmpeg', '-i', video_path, '-vframes', '1',
            '-q:v', '2', cover_tmp, '-y', '-loglevel', 'error'
        ], check=True, timeout=30)
        cover = Picture.from_file(cover_tmp)
    except Exception as e:
        print(f"[WARN] 截取封面失败: {e}")

    if cover is None:
        print("[ERROR] 无法创建封面,跳过")
        return {"success": False, "title": title, "error": "no cover"}

    meta = video_uploader.VideoMeta(
        tid=DEFAULT_TID,
        title=title,
        desc=desc,
        cover=cover,
        tags=TAGS,
        original=False,
        source="直播切片",
    )

    uploader = video_uploader.VideoUploader(
        pages=[page],
        meta=meta,
        credential=credential,
    )

    try:
        result = await uploader.start()
        if result:
            bvid = result.get('bvid', 'N/A') if isinstance(result, dict) else 'N/A'
            print(f"  ✅ 成功! bvid: {bvid}")
            return {"success": True, "title": title, "bvid": bvid, "result": result}
        else:
            print(f"  ❌ 失败")
            return {"success": False, "title": title, "error": "upload returned falsy"}
    except Exception as e:
        print(f"  ❌ 异常: {e}")
        return {"success": False, "title": title, "error": str(e)}
    finally:
        if os.path.exists(cover_tmp):
            try:
                os.remove(cover_tmp)
            except:
                pass


async def main():
    credential = build_credential()
    print("[INFO] 凭证已创建")

    tasks = []
    for title, suffix in CLIPS:
        video_path = find_video_file(suffix)
        if not video_path:
            print(f"[WARN] 找不到视频文件: {suffix}")
            continue
        fixed = fix_title(title)
        tasks.append((video_path, fixed))

    print(f"[INFO] 共 {len(tasks)} 个视频待上传")

    results = []
    for i, (video_path, title) in enumerate(tasks, 1):
        print(f"\n[{i}/{len(tasks)}]")
        result = await upload_one(video_path, title, credential)
        results.append(result)

    total_success = sum(1 for r in results if r["success"])
    total_fail = len(results) - total_success
    print(f"\n{'='*60}")
    print(f"[全部完成] 共 {len(results)} 个, 成功 {total_success}, 失败 {total_fail}")
    print(f"{'='*60}")

    failed = [r for r in results if not r["success"]]
    if failed:
        print("\n失败列表:")
        for r in failed:
            print(f"  ❌ {r['title']} - {r.get('error', 'unknown')}")

    succeeded = [r for r in results if r["success"]]
    if succeeded:
        print("\n成功列表:")
        for r in succeeded:
            print(f"  ✅ {r['title']} - {r.get('bvid', 'N/A')}")

    result_path = os.path.join(CLIPS_DIR, "upload_results.json")
    with open(result_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\n[INFO] 结果已保存到 {result_path}")


if __name__ == "__main__":
    asyncio.run(main())
