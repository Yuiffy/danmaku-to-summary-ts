#!/usr/bin/env python3
"""
seedance_add_task.py — 向 seedance_queue.json 安全添加任务

用法:
  python seedance_add_task.py add \
    --name "深夜厨房煮泡面" \
    --prompt "16:9横屏，高质量二次元动画..." \
    --refs sport,binggan,sport_illust \
    --repeat 3

  python seedance_add_task.py list-refs

特性:
  - 参考图用短名称（enum），自动转绝对路径
  - 添加前验证所有路径存在
  - 验证参数完整性
  - 自动递增 task ID
"""

import argparse
import json
import os
import sys
from pathlib import Path

# ── 队列文件路径 ──
QUEUE_PATH = Path(r"D:\files\Pictures\AI图保存\seedance\近期岁己居家下载\seedance_queue.json")

# ── 素材根目录 ──
XIAOHUAMA = Path(r"D:\files\Pictures\保存素材\小花帽")
XIAOLANMAO = Path(r"D:\files\Pictures\保存素材\小蓝帽")
XIAOMAOHAO = Path(r"D:\files\Pictures\保存素材\小猫帽")
XIAOHONGMAO = Path(r"D:\files\Pictures\保存素材\VirtuaReal和PSP同事\岁己SUI")
GPT_DIR = Path(r"D:\files\Pictures\AI图保存\gpt")
PROJECT_REFS = Path(r"D:\workspace\myrepo\danmaku-to-summary-ts\public\reference_images")

# ── 参考图短名称 → 绝对路径映射 ──
REF_MAP = {
    # === 岁己 - 小花帽系（白色连衣裙） ===
    "xiaohuamao":        XIAOHUAMA / "73913dc4ed291e630f765bd14bcd15cc1954091502.png",  # 小花帽白色连衣裙立绘
    "xiaohuamao_2":      XIAOHUAMA / "622764c8178eb3f6411da20a917cc0321954091502.png",
    "xiaohuamao_3":      XIAOHUAMA / "21d72930b566f878ff8cdbff9b468ca11954091502.png",
    "xiaohuamao_4":      XIAOHUAMA / "6c6e83dad538cf0ba8434a417f6f343b1954091502.png",
    "xiaohuamao_5":      XIAOHUAMA / "cee3461dc483b51ac9befd4663c1235e1954091502.png",

    # === 运动系 ===
    "sport":             XIAOHUAMA / "AI素材" / "红白健身服装2.png",            # 运动服定妆
    "sport_1":           XIAOHUAMA / "AI素材" / "红白健身服装1.png",
    "sport_illust":      XIAOHUAMA / "AI素材" / "红白健身服装2定妆插画.png",     # 画面风格参考
    "sweat_ref":         XIAOHUAMA / "AI素材" / "岁己运动后擦汗参考.jpg",        # 运动后擦汗姿态

    # === 睡裙/卧室系 ===
    "sleepwear_3view":   XIAOHUAMA / "AI素材" / "吊带连衣裙三视图.png",          # 三视图
    "sleepwear_illust":  XIAOHUAMA / "AI素材" / "吊带连衣裙睡衣定妆插画.png",    # 睡衣定妆
    "shorts_pj_3view":   XIAOHUAMA / "AI素材" / "短裤睡衣三视图.png",

    # === 小蓝帽系（时尚短裙） ===
    "lanmao_1":          XIAOLANMAO / "12038c997389adefd7c097b20311b83c.png",
    "lanmao_2":          XIAOLANMAO / "5a2bcc519c33a2213134bdc196799d041954091502.png",
    "lanmao_3":          XIAOLANMAO / "ffafa81afd68e22166a93dfd806f9af81954091502.png",
    "lanmao_3view":      XIAOHUAMA / "AI素材" / "小蓝帽三视图.png",
    "lanmao_twin":       XIAOLANMAO / "岁己_20231216形象_双马尾有外套.webp",
    "lanmao_short":      XIAOLANMAO / "岁己_20231216形象_短发无外套.webp",

    # === 小猫帽系（赛博短裤网袜） ===
    "maohao_pb":         XIAOMAOHAO / "岁己SUI小猫帽带饼干岁紫色外套双马尾.png",  # 带饼干岁，常用
    "maohao_mask":       XIAOMAOHAO / "岁己SUI小猫帽口罩双马尾.png",
    "maohao_hood":       XIAOMAOHAO / "岁己SUI小猫帽戴兜帽wink红瞳.PNG",
    "maohao_long_gold":  XIAOMAOHAO / "岁己SUI小猫帽无外套长发金瞳.PNG",
    "maohao_short_gold": XIAOMAOHAO / "岁己SUI小猫帽短发小揪揪半身金瞳.png",

    # === 小红帽系（地雷） ===
    "hongmao":           XIAOHONGMAO / "小红帽立绘.png",

    # === 饼干岁 ===
    "binggan":           XIAOHUAMA / "AI素材" / "饼干岁人2.png",   # 饼干岁定妆（常用）
    "binggan_1":         XIAOHUAMA / "AI素材" / "饼干岁人1.png",

    # === 电车场景 GPT 图 ===
    "tram_gpt":          GPT_DIR / "ChatGPT Image 2026年6月26日 01_18_54.png",  # 电车上运动岁己+脸红小饼

    # === 项目内参考图 ===
    "maohao_pb_ref":     PROJECT_REFS / "岁己SUI小猫帽带饼干岁紫色外套双马尾.png",
}


def resolve_refs(short_names: list[str]) -> list[str]:
    """短名称列表 → 绝对路径列表，验证存在性"""
    paths = []
    errors = []
    for name in short_names:
        if name not in REF_MAP:
            errors.append(f"  ✗ 未知参考图短名称: '{name}'")
            continue
        p = REF_MAP[name]
        if not p.exists():
            errors.append(f"  ✗ 文件不存在: '{name}' → {p}")
            continue
        paths.append(str(p))
    if errors:
        print("参考图验证失败:", file=sys.stderr)
        for e in errors:
            print(e, file=sys.stderr)
        sys.exit(1)
    return paths


def next_task_id(tasks: list) -> str:
    """获取下一个 task ID"""
    max_num = 0
    for t in tasks:
        try:
            num = int(t["id"].replace("task_", ""))
            max_num = max(max_num, num)
        except (ValueError, KeyError):
            continue
    return f"task_{max_num + 1:03d}"


def add_task(name: str, prompt: str, refs: list[str], repeat: int, ratio: str = "16:9"):
    """添加任务到队列"""
    if not QUEUE_PATH.exists():
        print(f"✗ 队列文件不存在: {QUEUE_PATH}", file=sys.stderr)
        sys.exit(1)

    with open(QUEUE_PATH, "r", encoding="utf-8") as f:
        q = json.load(f)

    # 验证参数
    if not name.strip():
        print("✗ name 不能为空", file=sys.stderr)
        sys.exit(1)
    if not prompt.strip():
        print("✗ prompt 不能为空", file=sys.stderr)
        sys.exit(1)
    valid_ratios = {"1:1", "3:4", "16:9", "4:3", "9:16", "21:9"}
    if ratio not in valid_ratios:
        print(f"✗ ratio 无效: '{ratio}'，可选: {', '.join(sorted(valid_ratios))}", file=sys.stderr)
        sys.exit(1)
    if repeat < 1 or repeat > 20:
        print(f"✗ repeat 应在 1-20 之间，当前: {repeat}", file=sys.stderr)
        sys.exit(1)
    if not refs:
        print("✗ 至少需要一个参考图", file=sys.stderr)
        sys.exit(1)

    # 解析参考图
    ref_paths = resolve_refs(refs)

    # 生成新 task
    task_id = next_task_id(q["tasks"])
    task = {
        "id": task_id,
        "name": name,
        "prompt": prompt,
        "reference_images": ref_paths,
        "ratio": ratio,
        "repeat": repeat,
        "completed": 0,
        "status": "pending",
        "submit_ids": [],
    }

    q["tasks"].append(task)

    with open(QUEUE_PATH, "w", encoding="utf-8") as f:
        json.dump(q, f, ensure_ascii=False, indent=2)

    print(f"✅ 已添加 {task_id}: {name}")
    print(f"   repeat={repeat}, refs={refs}")
    print(f"   总任务数: {len(q['tasks'])}")


def list_refs():
    """列出所有可用参考图短名称"""
    print(f"{'短名称':<20} {'存在':>4}  路径")
    print("─" * 90)
    for name, path in sorted(REF_MAP.items()):
        exists = "✅" if path.exists() else "❌"
        print(f"{name:<20} {exists:>4}  {path}")


def list_refs_json():
    """JSON 格式输出参考图列表"""
    data = []
    for name, path in sorted(REF_MAP.items()):
        data.append({"name": name, "path": str(path), "exists": path.exists()})
    print(json.dumps(data, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="向 seedance_queue.json 安全添加任务")
    sub = parser.add_subparsers(dest="command")

    # add 子命令
    p_add = sub.add_parser("add", help="添加新任务")
    p_add.add_argument("--name", required=True, help="任务名称")
    p_add.add_argument("--prompt", required=True, help="生成 prompt")
    p_add.add_argument("--refs", required=True, help="参考图短名称，逗号分隔 (如 sport,binggan)")
    p_add.add_argument("--repeat", type=int, default=3, help="重复次数 (默认3)")
    p_add.add_argument("--ratio", default="16:9", help="视频比例 (默认16:9): 1:1, 3:4, 16:9, 4:3, 9:16, 21:9")

    # list-refs 子命令
    sub.add_parser("list-refs", help="列出所有可用参考图短名称")

    # list-refs-json 子命令
    sub.add_parser("list-refs-json", help="JSON 格式列出参考图")

    # list-tasks 子命令
    p_list = sub.add_parser("list-tasks", help="列出任务状态")
    p_list.add_argument("--status", default=None, help="按状态过滤 (pending/completed/paused)")

    args = parser.parse_args()

    if args.command == "add":
        refs = [r.strip() for r in args.refs.split(",") if r.strip()]
        add_task(args.name, args.prompt, refs, args.repeat, args.ratio)

    elif args.command == "list-refs":
        list_refs()

    elif args.command == "list-refs-json":
        list_refs_json()

    elif args.command == "list-tasks":
        with open(QUEUE_PATH, "r", encoding="utf-8") as f:
            q = json.load(f)
        tasks = q["tasks"]
        if args.status:
            tasks = [t for t in tasks if t.get("status") == args.status]
        for t in tasks:
            print(f"{t['id']}: [{t.get('status','?'):>8}] repeat={t.get('repeat',0)} done={t.get('completed',0)}  {t['name']}")

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
