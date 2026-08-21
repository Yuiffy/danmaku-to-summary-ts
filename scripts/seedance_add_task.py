#!/usr/bin/env python3
"""
seedance_add_task.py — 向 seedance_queue.json 安全添加任务

用法:
  python seedance_add_task.py add \
    --name "深夜厨房煮泡面" \
    --prompt "16:9横屏，高质量二次元动画..." \
    --refs sport,binggan,sport_illust \
    --repeat 2

  python seedance_add_task.py list-refs

特性:
  - 参考图用短名称（enum），自动转绝对路径
  - 添加前验证所有路径存在
  - 验证参数完整性
  - 自动递增 task ID
"""

import argparse
import json
import sys
from pathlib import Path

from seedance_model_caps import VALID_MODELS, VALID_RESOLUTIONS, duration_bounds, supported_resolutions
from seedance_queue_store import DEFAULT_QUEUE_PATH, QueueStore

# ── 队列文件路径 ──
QUEUE_PATH = DEFAULT_QUEUE_PATH
VALID_STATUSES = {"pending", "paused"}

# ── 素材根目录 ──
XIAOHUAMA = Path(r"D:\files\Pictures\保存素材\小花帽")
XIAOLANMAO = Path(r"D:\files\Pictures\保存素材\小蓝帽")
XIAOMAOHAO = Path(r"D:\files\Pictures\保存素材\小猫帽")
XIAOHONGMAO = Path(r"D:\files\Pictures\保存素材\VirtuaReal和PSP同事\岁己SUI")
GPT_DIR = Path(r"D:\files\Pictures\AI图保存\gpt")
PROJECT_REFS = Path(r"D:\workspace\myrepo\danmaku-to-summary-ts\public\reference_images")
PROJECT_IMAGEGEN = Path(r"D:\workspace\myrepo\danmaku-to-summary-ts\output\imagegen")
SHORT_DRAMA_REFS = Path(r"D:\files\Pictures\保存素材\短剧素材\新短剧素材20260802")
SUI_VOICE_SAMPLE = Path(r"D:\files\Pictures\保存素材\VirtuaReal和PSP同事\岁己SUI\饼干岁我告诉你只许喜欢我一个人，不许跟别的女人说话！.MP3")

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
    "lanmao_strengthened_2_daxiong": XIAOHUAMA / "AI素材" / "小蓝帽三视图加强版2_大熊.png",  # 用户精修版小蓝帽三视图
    "lanmao_shopping_3view": PROJECT_IMAGEGEN / "sui_lanmao_shopping_3view_v1.png",  # 日常逛街服三视图
    "lanmao_body_detail_3view": PROJECT_IMAGEGEN / "sui_lanmao_body_detail_3view_v1.png",  # 身材细节加强版三视图
    "lanmao_summer_body_detail_3view": PROJECT_IMAGEGEN / "sui_lanmao_summer_body_detail_3view_v1.png",  # 夏日身材细节加强版三视图
    "lanmao_original_outfit_detail_3view": PROJECT_IMAGEGEN / "sui_lanmao_original_outfit_detail_3view_v2.png",  # 原版大胆穿搭身材细节加强版三视图
    "lanmao_summer_nojacket_flatshoe_3view": PROJECT_IMAGEGEN / "sui_lanmao_summer_nojacket_flatshoe_3view_v3.png",  # 夏日脱外套平底鞋三视图
    "lanmao_summer_nojacket_flatshoe_realistic_3view": PROJECT_IMAGEGEN / "sui_lanmao_summer_nojacket_flatshoe_realistic_3view_v4.png",  # 夏日脱外套平底鞋自然写实三视图
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

    # === 便利店夜班连续剧情（API 生图资产） ===
    "nightshift_sui":    Path(r"D:\files\Pictures\AI图保存\api生成\nightshift_sui_clerk_v2.png"),
    "nightshift_binggan": Path(r"D:\files\Pictures\AI图保存\api生成\nightshift_binggan_courier_v1.png"),
    "nightshift_store":  Path(r"D:\files\Pictures\AI图保存\api生成\nightshift_store_interior_v1.png"),
    "nightshift_duo":    Path(r"D:\files\Pictures\AI图保存\api生成\nightshift_duo_counter_v1.png"),
    "nightshift_offduty": Path(r"D:\files\Pictures\AI图保存\api生成\nightshift_sui_offduty_v1.png"),

    # === 武侠系 ===
    "wuxia_sui_3view":   XIAOHUAMA / "AI素材" / "武侠岁己三视图.png",       # 武侠岁己三视图
    "wuxia_binggan_3view": XIAOHUAMA / "AI素材" / "武侠饼干岁三视图.png",    # 武侠饼干岁三视图

    # === 新短剧素材 20260802（本次装机短剧） ===
    "short_drama_sleepwear": SHORT_DRAMA_REFS / "吊带连衣裙三视图.png",
    "short_drama_sleepwear_illust": SHORT_DRAMA_REFS / "吊带连衣裙睡衣定妆插画.png",
    "short_drama_convex_sleepwear": SHORT_DRAMA_REFS / "凸出睡衣岁己.png",
    "short_drama_lanmao_big": SHORT_DRAMA_REFS / "小蓝帽三视图加强版2_大熊.png",
    "short_drama_sport": SHORT_DRAMA_REFS / "红白健身服装2.png",
    "short_drama_sport_illust": SHORT_DRAMA_REFS / "红白健身服装2定妆插画.png",
    "short_drama_outdoor_sui": SHORT_DRAMA_REFS / "运动外出岁己.png",  # 运动外出岁己定妆
    "short_drama_rtx5090_box": SHORT_DRAMA_REFS / "RTX5090显卡包装参考.jpg",  # RTX 5090包装结构参考

    # === 其他角色 ===
    "shiori":            Path(r"D:\files\Pictures\保存素材\VirtuaReal和PSP同事\栞栞Shiori\栞栞立绘.webp"),
    "yua_glasses":       Path(r"D:\files\Pictures\保存素材\悠亚外套眼镜.png"),
    "yua_head":          Path(r"D:\files\Pictures\保存素材\Yua头图.webp"),

    # === 项目内参考图 ===
    "maohao_pb_ref":     PROJECT_REFS / "岁己SUI小猫帽带饼干岁紫色外套双马尾.png",
    "villain_boss":      PROJECT_IMAGEGEN / "convenience_store_villain_boss_v1.png",  # 无眼匿名便利店老板
    "convenience_store_boss_store": PROJECT_IMAGEGEN / "convenience_store_boss_store_reference_v1.png",  # 用户提供的老板与小卖部参考图1
    "convenience_store_basement": PROJECT_IMAGEGEN / "convenience_store_basement_reference_v1.png",  # 用户提供的地下室参考图2
}

AUDIO_MAP = {
    "sui_voice_sample": SUI_VOICE_SAMPLE,
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


def resolve_audio_refs(short_names: list[str]) -> list[str]:
    """音频参考短名称 → 绝对路径，验证存在性"""
    paths = []
    errors = []
    for name in short_names:
        if name not in AUDIO_MAP:
            errors.append(f"  ✗ 未知音频参考短名称: '{name}'")
            continue
        p = AUDIO_MAP[name]
        if not p.exists():
            errors.append(f"  ✗ 音频文件不存在: '{name}' → {p}")
            continue
        paths.append(str(p))
    if errors:
        print("音频参考验证失败:", file=sys.stderr)
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


def add_task(name: str, prompt: str, refs: list[str], repeat: int, ratio: str = "16:9", model_version: str = "seedance2.0", resolution: str = "720p", queue_path: Path = QUEUE_PATH, task_id: str | None = None, duration: int = 15, audio_refs: list[str] | None = None, initial_status: str = "pending"):
    """添加任务到队列。模型决定进入普通或 VIP 线上通道。"""
    if not queue_path.exists():
        print(f"✗ 队列文件不存在: {queue_path}", file=sys.stderr)
        sys.exit(1)

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
    if repeat < 1 or repeat > 200:
        print(f"✗ repeat 应在 1-200 之间，当前: {repeat}", file=sys.stderr)
        sys.exit(1)
    if model_version not in VALID_MODELS:
        print(f"✗ model-version 无效: '{model_version}'，可选: {', '.join(sorted(VALID_MODELS))}", file=sys.stderr)
        sys.exit(1)
    minimum, maximum = duration_bounds(model_version)
    if duration < minimum or duration > maximum:
        print(f"✗ {model_version} 的 duration 应在 {minimum}-{maximum} 秒之间，当前: {duration}", file=sys.stderr)
        sys.exit(1)
    if resolution not in supported_resolutions(model_version):
        print(f"✗ {model_version} 不支持分辨率: '{resolution}'", file=sys.stderr)
        sys.exit(1)
    if not refs:
        print("✗ 至少需要一个参考图", file=sys.stderr)
        sys.exit(1)
    if initial_status not in VALID_STATUSES:
        print(f"✗ initial-status 无效: '{initial_status}'，可选: {', '.join(sorted(VALID_STATUSES))}", file=sys.stderr)
        sys.exit(1)

    ref_paths = resolve_refs(refs)
    audio_paths = resolve_audio_refs(audio_refs or [])
    store = QueueStore(queue_path)
    with store.transaction() as q:
        if task_id is None:
            task_id = next_task_id(q["tasks"])
        elif any(str(task.get("id")) == task_id for task in q["tasks"]):
            print(f"✗ task ID 已存在: '{task_id}'", file=sys.stderr)
            sys.exit(1)
        task = {
            "id": task_id,
            "name": name,
            "prompt": prompt,
            "reference_images": ref_paths,
            "audio_references": audio_paths,
            "ratio": ratio,
            "model_version": model_version,
            "video_resolution": resolution,
            "duration": duration,
            "repeat": repeat,
            "completed": 0,
            "status": initial_status,
            "submit_ids": [],
            "inflight": [],
        }
        q["tasks"].append(task)
        store.save(q)
        task_count = len(q["tasks"])

    lane = "普通" if model_version == "seedance2.0" else "VIP"
    print(f"✅ 已添加 {task_id}: {name}")
    print(f"   repeat={repeat}, duration={duration}s, refs={refs}, audio={audio_refs or []}, model={model_version}, resolution={resolution}, status={initial_status}, 通道={lane}")
    print(f"   总任务数: {task_count}")


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
    p_add.add_argument("--repeat", type=int, default=2, help="重复次数 (默认2，最多200)")
    p_add.add_argument("--ratio", default="16:9", help="视频比例 (默认16:9): 1:1, 3:4, 16:9, 4:3, 9:16, 21:9")
    p_add.add_argument("--model-version", default="seedance2.0", choices=sorted(VALID_MODELS), help="生成模型；seedance2.0 走普通通道，其余模型走 VIP 通道")
    p_add.add_argument("--resolution", default="720p", choices=sorted(VALID_RESOLUTIONS), help="视频分辨率；2.5 支持 480p/720p/1080p")
    p_add.add_argument("--duration", type=int, default=15, help="视频时长；2.5 支持 4-30 秒，其余模型 4-15 秒")
    p_add.add_argument("--audio-refs", default="", help="音频参考短名称，逗号分隔，例如 sui_voice_sample")
    p_add.add_argument("--initial-status", default="pending", choices=sorted(VALID_STATUSES), help="初始状态；paused 用于先建档再分批释放")
    p_add.add_argument("--task-id", default=None, help="显式任务 ID，例如 task_153；用于保持删除任务后的编号连续性")
    p_add.add_argument("--queue", type=Path, default=QUEUE_PATH, help="队列文件路径（测试/维护覆盖）")

    # list-refs 子命令
    sub.add_parser("list-refs", help="列出所有可用参考图短名称")

    # list-refs-json 子命令
    sub.add_parser("list-refs-json", help="JSON 格式列出参考图")

    # list-tasks 子命令
    p_list = sub.add_parser("list-tasks", help="列出任务状态")
    p_list.add_argument("--status", default=None, help="按状态过滤 (pending/completed/paused)")
    p_list.add_argument("--queue", type=Path, default=QUEUE_PATH, help="队列文件路径（测试/维护覆盖）")

    args = parser.parse_args()

    if args.command == "add":
        refs = [r.strip() for r in args.refs.split(",") if r.strip()]
        audio_refs = [r.strip() for r in args.audio_refs.split(",") if r.strip()]
        add_task(args.name, args.prompt, refs, args.repeat, args.ratio, args.model_version, args.resolution, args.queue, args.task_id, args.duration, audio_refs, args.initial_status)

    elif args.command == "list-refs":
        list_refs()

    elif args.command == "list-refs-json":
        list_refs_json()

    elif args.command == "list-tasks":
        q = QueueStore(args.queue).load()
        tasks = q["tasks"]
        if args.status:
            tasks = [t for t in tasks if t.get("status") == args.status]
        for t in tasks:
            model = str(t.get("model_version") or "seedance2.0")
            lane = "normal" if model == "seedance2.0" else "vip"
            active = len(t.get("inflight") or []) + len(t.get("submission_reservations") or [])
            remaining = max(0, int(t.get("repeat") or 0) - int(t.get("completed") or 0))
            print(f"{t['id']}: [{t.get('status','?'):>8}] lane={lane:<6} model={model:<22} repeat={t.get('repeat',0)} done={t.get('completed',0)} active={active} remaining={remaining}  {t['name']}")

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
