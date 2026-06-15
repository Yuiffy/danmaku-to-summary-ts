#!/usr/bin/env python
"""
批量上传切片到B站
- 第一批上传10个,等待5分钟,再上传剩余8个
- 不自动重试
- 标题中"岁己"替换为"小岁",并加【小岁】前缀
"""
import sys
import os
import json
import asyncio
import time
import subprocess

# 添加项目路径
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(project_root, 'src', 'scripts'))

from config_loader import get_config, find_secrets_path
from bilibili_api import Credential, video_uploader, Picture

DEFAULT_TID = 21  # 日常
ACCOUNT_MID = 412141275
CLIPS_DIR = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_14\own_stream_fun_clips"
TAGS = ["小岁", "虚拟主播", "直播切片", "岁AI切片"]
SOURCE_DESC = "岁己SUI 直播《悠哉悠哉夜晚》2026-06-14"

# 18个切片信息 (title, filename)
CLIPS = [
    ("开播迟到竟是因为搬不动水桶?这种原始人饮水方式让弹幕全看傻了", "fun_01_000843"),
    ("听说群友一块钱买两根雪糕当场破防,嘴硬表示:三块五买到就不算亏", "fun_02_001329"),
    ("看到游泳教练朋友圈就压力大,想屏蔽又怕显得自暴自弃,这逻辑绝了", "fun_03_005540"),
    ('纯手工御守首秀当场翻车，这“平安”二字让全直播间弹幕笑出猪叫', 'fun_04_010236'),
    ("弹幕疯狂要求在御守里塞头发,小岁:我又不掉发,难道要现场拔吗", "fun_05_010616"),
    ("写手写信竟然还要查成分?小岁:一眼看到你们在别处的阴暗面,有人流汗了", "fun_06_011349"),
    ("饼干岁看擦边被当场抓包?小岁:真下流!能不能给我高雅一点!", "fun_07_011806"),
    ("刚唱完就被弹幕拆穿上个月刚唱过,小岁理直气壮拒不认账:这谁记得住呀", "fun_08_014129"),
    ("自信锐评《下等马》方言味太冲,得知原唱竟是日本出身后当场瞳孔地震", "fun_09_020109"),
    ("煞有介事说要去拿非常重要的文件,结果搬回海量零食,弹幕:这就是你的文件?", "fun_10_020912"),
    ("玩空洞骑士强行卸下指南针,小岁迷之自信直言我找得到路,弹幕已经开始急了", "fun_11_021153"),
    ("掉两滴血再回就不亏?这波逻辑给弹幕CPU干烧了,这就是聪明小岁吗", "fun_12_021515"),
    ("满心欢喜去救毛毛虫结果被咬,这反转让小岁当场黑化:怎么还有这种秘密?", "fun_13_022447"),
    ("存进去的钱全没了?发现银行是纸糊的那一刻,小岁当场红了", "fun_14_030655"),
    ("身怀六千巨款进店扫货,这就是富婆的底气吗?小岁:全买了我有钱", "fun_15_031503"),
    ("自封操作无敌转头就被炸飞,小岁独创全伤流跑酷给弹幕看傻了", "fun_16_034537"),
    ("别生气会把身体气坏的,绿茶小岁上线温柔补刀,弹幕:是被你气坏的", "fun_17_035158"),
    ("全屏弹幕急到复读刷屏,小岁对着隐藏墙硬是看不见,这就是路痴的压迫感吗", "fun_18_040229"),
]


def fix_title(title: str) -> str:
    """替换岁己为小岁,加前缀"""
    title = title.replace("岁己", "小岁")
    if not title.startswith("【小岁】"):
        title = f"【小岁】{title}"
    return title


def find_video_file(suffix: str) -> str:
    """根据后缀找到视频文件"""
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


async def upload_one(video_path: str, title: str, desc: str, credential: Credential) -> dict:
    """上传单个视频,返回结果dict"""
    file_size = os.path.getsize(video_path) / (1024 * 1024)
    print(f"\n{'='*60}")
    print(f"[UPLOAD] {title}")
    print(f"[FILE] {os.path.basename(video_path)} ({file_size:.1f}MB)")

    page = video_uploader.VideoUploaderPage(
        path=video_path,
        title=title,
        description=desc,
    )

    # 截取封面
    cover_tmp = os.path.join(os.path.dirname(video_path), '_tmp_cover.jpg')
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
        # 清理临时封面
        if os.path.exists(cover_tmp):
            try:
                os.remove(cover_tmp)
            except:
                pass


async def main():
    credential = build_credential()
    print("[INFO] 凭证已创建")

    # 准备所有上传任务
    tasks = []
    for title, suffix in CLIPS:
        video_path = find_video_file(suffix)
        if not video_path:
            print(f"[WARN] 找不到视频文件: {suffix}")
            continue
        fixed = fix_title(title)
        desc = f"直播切片\n\n来源:{SOURCE_DESC}"
        tasks.append((video_path, fixed, desc))

    print(f"[INFO] 共 {len(tasks)} 个视频待上传")
    print(f"[INFO] 第一批: {len(tasks[:10])} 个")
    print(f"[INFO] 第二批: {len(tasks[10:])} 个 (等待5分钟后上传)")

    results = []

    # 第一批: 前10个
    print(f"\n{'#'*60}")
    print(f"# 第一批上传 ({len(tasks[:10])} 个)")
    print(f"{'#'*60}")
    for i, (video_path, title, desc) in enumerate(tasks[:10], 1):
        print(f"\n[批次1 - {i}/{len(tasks[:10])}]")
        result = await upload_one(video_path, title, desc, credential)
        results.append(result)

    batch1_success = sum(1 for r in results if r["success"])
    batch1_fail = len(results) - batch1_success
    print(f"\n[批次1完成] 成功 {batch1_success}, 失败 {batch1_fail}")

    # 等待5分钟
    print(f"\n[INFO] 等待5分钟后上传第二批...")
    for remaining in range(300, 0, -10):
        print(f"  剩余 {remaining} 秒...", end='\r')
        await asyncio.sleep(10)
    print(" " * 30, end='\r')

    # 第二批: 剩余8个
    print(f"\n{'#'*60}")
    print(f"# 第二批上传 ({len(tasks[10:])} 个)")
    print(f"{'#'*60}")
    for i, (video_path, title, desc) in enumerate(tasks[10:], 1):
        print(f"\n[批次2 - {i}/{len(tasks[10:])}]")
        result = await upload_one(video_path, title, desc, credential)
        results.append(result)

    # 汇总
    total_success = sum(1 for r in results if r["success"])
    total_fail = len(results) - total_success
    print(f"\n{'='*60}")
    print(f"[全部完成] 共 {len(results)} 个, 成功 {total_success}, 失败 {total_fail}")
    print(f"{'='*60}")

    # 打印失败的
    failed = [r for r in results if not r["success"]]
    if failed:
        print("\n失败列表:")
        for r in failed:
            print(f"  ❌ {r['title']} - {r.get('error', 'unknown')}")

    # 打印成功的BV号
    succeeded = [r for r in results if r["success"]]
    if succeeded:
        print("\n成功列表:")
        for r in succeeded:
            print(f"  ✅ {r['title']} - {r.get('bvid', 'N/A')}")

    # 保存结果到json
    result_path = os.path.join(CLIPS_DIR, "upload_results.json")
    with open(result_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\n[INFO] 结果已保存到 {result_path}")


if __name__ == "__main__":
    asyncio.run(main())
