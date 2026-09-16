"""
批量更新切片封面到B站

用法：
    python batch_update_covers.py --state upload_state.json --clips-dir <clips目录>

从 upload_state.json 读取 BV 号映射，从 clips_dir 读取 cover_XX_sui.jpg，
逐一上传更新封面。

也可以手动指定 --only 5,6,7 只更新指定编号。
"""
import argparse
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))

from update_cover import update_cover

SECRET_DEFAULT = os.path.join(
    os.path.dirname(__file__), "..", "..", "config", "secret.json"
)


def load_bvid_map(state_path: str) -> dict[int, str]:
    """从 upload_state.json 加载 {clip_index: bvid}"""
    with open(state_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    result = {}
    for k, v in data.get("done", {}).items():
        result[int(k)] = v["bvid"]
    return result


async def main():
    parser = argparse.ArgumentParser(description="批量更新切片封面")
    parser.add_argument(
        "--state",
        default="upload_state.json",
        help="upload_state.json 路径",
    )
    parser.add_argument(
        "--clips-dir", required=True, help="切片目录（含 cover_XX_sui.jpg）"
    )
    parser.add_argument(
        "--secret", default=SECRET_DEFAULT, help="secret.json 路径"
    )
    parser.add_argument(
        "--only", default=None, help="只更新指定编号（逗号分隔，如 5,6,7）"
    )
    parser.add_argument(
        "--suffix", default="sui", help="封面文件后缀（如 cover_01_sui.jpg）"
    )
    parser.add_argument("--delay", type=int, default=2, help="每次更新间隔秒数")
    args = parser.parse_args()

    bvid_map = load_bvid_map(args.state)
    secret_abs = os.path.abspath(args.secret)

    only_set = None
    if args.only:
        only_set = set(int(x) for x in args.only.split(","))

    success, fail = 0, 0
    for i in sorted(bvid_map.keys()):
        if only_set and i not in only_set:
            continue

        bvid = bvid_map[i]
        cover_file = os.path.join(args.clips_dir, f"cover_{i:02d}_{args.suffix}.jpg")

        if not os.path.exists(cover_file):
            print(f"[{i:02d}] SKIP - 封面不存在: {cover_file}")
            continue

        print(f"\n[{i:02d}] 更新封面 {bvid} ...")
        try:
            await update_cover(bvid, cover_file, None, secret_abs)
            print(f"[{i:02d}] ✅ OK")
            success += 1
        except Exception as e:
            print(f"[{i:02d}] ❌ ERROR: {e}")
            fail += 1

        if args.delay > 0:
            time.sleep(args.delay)

    print(f"\n=== 完成: {success} 成功, {fail} 失败 ===")


if __name__ == "__main__":
    asyncio.run(main())
