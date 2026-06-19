"""
批量生成切片封面并上传到B站

流程：
1. 从 upload_state.json 读取 BV号映射
2. 从 REVIEW.md 读取标题
3. 对每个切片：用 cover_generator.py 从视频截帧 + 加文字 → 生成 cover_XX_sui.jpg
4. 上传封面到B站

用法：
    python batch_generate_covers.py --clips-dir <切片目录> --suffix sui
"""
import argparse
import asyncio
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from cover_generator import CoverGenerator
from update_cover import update_cover

SECRET_DEFAULT = os.path.join(
    os.path.dirname(__file__), "..", "..", "config", "secret.json"
)


def parse_review(review_path: str) -> dict[int, str]:
    """从 REVIEW.md 解析 {clip_index: title}（去掉前缀）"""
    with open(review_path, "r", encoding="utf-8") as f:
        content = f.read()
    result = {}
    for line in content.split("\n"):
        m = re.match(r"(\d+)\.\s+(.+?)\s*\|", line)
        if m:
            idx = int(m.group(1))
            title = m.group(2).strip()
            result[idx] = title
    return result


def load_bvid_map(state_path: str) -> dict[int, str]:
    with open(state_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return {int(k): v["bvid"] for k, v in data.get("done", {}).items()}


def find_clip_mp4(clips_dir: str, idx: int) -> str | None:
    """找到对应序号的切片mp4"""
    prefix = f"fun_{idx:02d}_"
    for f in os.listdir(clips_dir):
        if prefix in f and f.endswith(".mp4") and "recut" not in f and "final" not in f:
            return os.path.join(clips_dir, f)
    return None


async def main():
    parser = argparse.ArgumentParser(description="批量生成封面并上传")
    parser.add_argument("--clips-dir", required=True, help="切片目录")
    parser.add_argument("--review", default=None, help="REVIEW.md路径（默认clips-dir下）")
    parser.add_argument("--state", default=None, help="upload_state.json路径")
    parser.add_argument("--secret", default=SECRET_DEFAULT, help="secret.json路径")
    parser.add_argument("--suffix", default="sui", help="封面文件后缀")
    parser.add_argument("--only", default=None, help="只处理指定编号")
    parser.add_argument("--no-upload", action="store_true", help="只生成不上传")
    parser.add_argument("--delay", type=int, default=3, help="上传间隔秒数")
    args = parser.parse_args()

    clips_dir = os.path.abspath(args.clips_dir)
    review_path = args.review or os.path.join(clips_dir, "REVIEW.md")
    state_path = args.state or os.path.join(clips_dir, "upload_state.json")
    secret_abs = os.path.abspath(args.secret)

    titles = parse_review(review_path)
    bvid_map = load_bvid_map(state_path)

    only_set = set(int(x) for x in args.only.split(",")) if args.only else None

    gen = CoverGenerator()
    success, fail = 0, 0

    for i in sorted(bvid_map.keys()):
        if only_set and i not in only_set:
            continue

        bvid = bvid_map[i]
        title = titles.get(i, f"切片{i}")
        # 去掉【小岁】前缀作为封面文字
        cover_text = title.replace("【小岁】", "").replace("【小栞】", "")
        # 封面文字取前16个字
        if len(cover_text) > 16:
            cover_text = cover_text[:16]

        cover_file = os.path.join(clips_dir, f"cover_{i:02d}_{args.suffix}.jpg")
        mp4 = find_clip_mp4(clips_dir, i)

        if not mp4:
            print(f"[{i:02d}] SKIP - 找不到切片mp4")
            continue

        # 生成封面
        print(f"\n[{i:02d}] 生成封面: {cover_text[:30]}...")
        try:
            gen.generate_cover(
                video_path=mp4,
                title=cover_text,
                subtitle=None,
                output_path=cover_file,
                use_key_frame=True,
            )
        except Exception as e:
            print(f"[{i:02d}] ❌ 封面生成失败: {e}")
            fail += 1
            continue

        if args.no_upload:
            print(f"[{i:02d}] ✅ 封面已生成（跳过上传）")
            success += 1
            continue

        # 上传封面
        print(f"[{i:02d}] 上传封面到 {bvid}...")
        try:
            await update_cover(bvid, cover_file, None, secret_abs)
            print(f"[{i:02d}] ✅ 封面已更新")
            success += 1
        except Exception as e:
            print(f"[{i:02d}] ❌ 封面上传失败: {e}")
            fail += 1

        if args.delay > 0:
            time.sleep(args.delay)

    print(f"\n=== 完成: {success} 成功, {fail} 失败 ===")


if __name__ == "__main__":
    asyncio.run(main())
